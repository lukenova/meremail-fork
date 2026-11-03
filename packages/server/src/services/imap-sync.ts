/**
 * Two-way IMAP folder sync.
 *
 * Keeps Meremail's folders and the IMAP server's mailboxes in step:
 *
 * - Server folders become Meremail folders (and the other way round), and a
 *   renamed or deleted Meremail folder is renamed or deleted on the server.
 * - A thread moved in Meremail has its messages moved on the server; a message
 *   moved on the server (by another client) moves its thread in Meremail.
 * - An email deleted in Meremail, for any reason, is deleted on the server.
 *   A message deleted on the server moves its thread to Meremail's Trash.
 *
 * Changes are detected against a baseline: where each email was last seen on
 * the server (email_imap_locations) and which folder each thread was in when
 * the two sides last agreed (thread_imap_sync). If both sides changed, the
 * Meremail side wins.
 *
 * Messages in Sent and Drafts are tracked (so deletes reach them) but never
 * moved, and never decide which folder a thread is in.
 *
 * IMAP_SYNC=off (default) | dry-run (log only) | on
 */
import {
  sqlite,
  createImapClient,
  toImportableEmail,
  backupEml,
  importEmail,
  toDate,
  config,
  TRASH_FOLDER_ID,
  INBOX_FOLDER_ID,
} from '@meremail/shared'
import { simpleParser } from 'mailparser'

type ImapFlow = Awaited<ReturnType<typeof createImapClient>>

const JUNK_FOLDER_ID = 2
const SYNC_INTERVAL = 2 * 60 * 1000
const REQUEST_DELAY = 3000
const FETCH_BATCH = 500

export type ImapSyncMode = 'off' | 'dry-run' | 'on'

export function imapSyncMode(): ImapSyncMode {
  const v = (process.env.IMAP_SYNC || 'off').toLowerCase()
  return v === 'on' || v === 'dry-run' ? v : 'off'
}

interface ServerMailbox {
  path: string
  delimiter: string
  specialUse?: string
}

interface Roles {
  inbox: string
  junk: string | null
  trash: string | null
  /** Tracked for deletes, never moved and never decide a thread's folder */
  passive: Set<string>
  /** Sent folders: new mail there is imported as sent mail */
  sent: Set<string>
  delimiter: string
  /** Prefix for new mailboxes, e.g. "INBOX." on servers that nest under INBOX */
  prefix: string
}

interface Location {
  emailId: number
  folder: string
  uid: number | null
  uidValidity: number | null
}

interface Seen {
  folder: string
  uid: number
  uidValidity: number
}

const log = (...args: unknown[]) => console.log('[ImapSync]', ...args)

const PASSIVE_NAMES = /^(sent|sent items|sent mail|sent messages|drafts|templates|outbox)$/i
const IGNORED_SPECIAL = new Set(['\\All', '\\Flagged', '\\Important'])

export function lastSegment(path: string, delimiter: string): string {
  if (!delimiter) return path
  const parts = path.split(delimiter)
  return parts[parts.length - 1] || path
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// ============== Database helpers ==============

// Statements are prepared on first use, after migrations have run
interface Stmt {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}
const statements = new Map<string, Stmt>()
function stmt(source: string): Stmt {
  let s = statements.get(source)
  if (!s) {
    s = sqlite.prepare(source) as unknown as Stmt
    statements.set(source, s)
  }
  return s
}

const q = {
  folders: () =>
    sqlite.prepare('SELECT id, name, imap_folder AS imapFolder, is_system AS isSystem FROM folders').all() as {
      id: number
      name: string
      imapFolder: string | null
      isSystem: number
    }[],
  locations: () =>
    sqlite
      .prepare('SELECT email_id AS emailId, imap_folder AS folder, uid, uid_validity AS uidValidity FROM email_imap_locations')
      .all() as Location[],
  get emailByMessageId() { return stmt('SELECT id, thread_id AS threadId FROM emails WHERE message_id = ?') },
  get isForgotten() { return stmt('SELECT 1 FROM imap_forgotten WHERE message_id = ?') },
  get upsertLocation() { return stmt(
    `INSERT INTO email_imap_locations (email_id, imap_folder, uid, uid_validity) VALUES (?, ?, ?, ?)
     ON CONFLICT(email_id) DO UPDATE SET imap_folder = excluded.imap_folder, uid = excluded.uid, uid_validity = excluded.uid_validity`
  ) },
  get deleteLocation() { return stmt('DELETE FROM email_imap_locations WHERE email_id = ?') },
  get threadSync() { return stmt('SELECT synced_folder_id AS f FROM thread_imap_sync WHERE thread_id = ?') },
  get setThreadSync() { return stmt(
    `INSERT INTO thread_imap_sync (thread_id, synced_folder_id) VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET synced_folder_id = excluded.synced_folder_id`
  ) },
  get thread() { return stmt('SELECT id, folder_id AS folderId FROM email_threads WHERE id = ?') },
  get threadEmails() { return stmt(
    `SELECT e.id, e.message_id AS messageId, COALESCE(e.received_at, e.sent_at, e.created_at) AS at
     FROM emails e WHERE e.thread_id = ?`
  ) },
}

/** Move a thread the same way the client's move/trash actions do */
function moveThreadLocally(threadId: number, folderId: number): void {
  const now = nowSeconds()
  const thread = q.thread.get(threadId) as { id: number; folderId: number } | undefined
  if (!thread || thread.folderId === folderId) return
  if (folderId === TRASH_FOLDER_ID) {
    sqlite
      .prepare('UPDATE email_threads SET previous_folder_id = ?, folder_id = ?, trashed_at = ?, updated_at = ? WHERE id = ?')
      .run(thread.folderId, TRASH_FOLDER_ID, now, now, threadId)
  } else {
    sqlite
      .prepare('UPDATE email_threads SET folder_id = ?, previous_folder_id = NULL, trashed_at = NULL, updated_at = ? WHERE id = ?')
      .run(folderId, now, threadId)
  }
}

// ============== The sync ==============

export class ImapSync {
  private running = false
  private again = false
  private timer: ReturnType<typeof setInterval> | null = null
  private requestTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly mode: () => ImapSyncMode = imapSyncMode) {}

  start(): void {
    if (this.mode() === 'off' || !config.imap.host) return
    log(`Starting in ${this.mode()} mode, every ${SYNC_INTERVAL / 1000}s`)
    setTimeout(() => this.run(), 20000)
    this.timer = setInterval(() => this.run(), SYNC_INTERVAL)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.requestTimer) clearTimeout(this.requestTimer)
    this.timer = null
  }

  /** Ask for a sync soon, e.g. after the user moved or deleted something */
  request(): void {
    if (this.mode() === 'off' || !this.timer) return
    if (this.requestTimer) clearTimeout(this.requestTimer)
    this.requestTimer = setTimeout(() => this.run(), REQUEST_DELAY)
  }

  async run(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    let client: ImapFlow | null = null
    try {
      client = await createImapClient()
      await this.syncWith(client)
    } catch (error) {
      console.error('[ImapSync] Sync failed:', error)
    } finally {
      if (client) {
        try {
          await client.logout()
        } catch {
          // ignore
        }
      }
      this.running = false
      if (this.again) {
        this.again = false
        setTimeout(() => this.run(), 1000)
      }
    }
  }

  /** One full pass against a connected client. Exposed for tests. */
  async syncWith(client: ImapFlow): Promise<void> {
    const dry = this.mode() !== 'on'
    const mailboxes = (await client.list()) as ServerMailbox[]
    const roles = this.roles(mailboxes)

    await this.syncFolders(client, mailboxes, roles, dry)

    const folderToImap = new Map<number, string>()
    const imapToFolder = new Map<string, number>()
    folderToImap.set(INBOX_FOLDER_ID, roles.inbox)
    imapToFolder.set(roles.inbox, INBOX_FOLDER_ID)
    if (roles.junk) {
      folderToImap.set(JUNK_FOLDER_ID, roles.junk)
      imapToFolder.set(roles.junk, JUNK_FOLDER_ID)
    }
    if (roles.trash) {
      folderToImap.set(TRASH_FOLDER_ID, roles.trash)
      imapToFolder.set(roles.trash, TRASH_FOLDER_ID)
    }
    for (const f of q.folders()) {
      if (!f.isSystem && f.imapFolder) {
        folderToImap.set(f.id, f.imapFolder)
        if (!imapToFolder.has(f.imapFolder)) imapToFolder.set(f.imapFolder, f.id)
      }
    }

    await this.processDeletes(client, roles, dry)

    const existing = new Set(mailboxes.map((m) => m.path))
    const scanFolders = [...new Set([...imapToFolder.keys(), ...roles.passive])].filter((p) => existing.has(p))
    const seen = await this.scan(client, scanFolders, roles, imapToFolder, dry)
    if (!seen) return

    await this.reconcile(client, seen, roles, folderToImap, imapToFolder, dry)
    await this.processDeletedFolders(client, dry)
  }

  private roles(mailboxes: ServerMailbox[]): Roles {
    const inbox = mailboxes.find((m) => m.path.toUpperCase() === 'INBOX')
    const delimiter = inbox?.delimiter || mailboxes.find((m) => m.delimiter)?.delimiter || '/'
    const bySpecial = (s: string) => mailboxes.find((m) => m.specialUse === s)?.path
    const byName = (n: string) => mailboxes.find((m) => m.path.toLowerCase() === n)?.path
    const passive = new Set(
      mailboxes
        .filter((m) => m.specialUse === '\\Sent' || m.specialUse === '\\Drafts' || PASSIVE_NAMES.test(m.path))
        .map((m) => m.path)
    )
    const sent = new Set(
      mailboxes.filter((m) => m.specialUse === '\\Sent' || /^(sent|sent items|sent mail|sent messages)$/i.test(m.path)).map((m) => m.path)
    )
    const nested = mailboxes.some((m) => m.path.toUpperCase().startsWith(`INBOX${delimiter}`))
    return {
      inbox: inbox?.path || 'INBOX',
      junk: bySpecial('\\Junk') || byName('junk') || byName('spam') || null,
      trash: bySpecial('\\Trash') || byName('trash') || null,
      passive,
      sent,
      delimiter,
      prefix: nested ? `${inbox?.path || 'INBOX'}${delimiter}` : '',
    }
  }

  /** Make both sides have the same set of folders */
  private async syncFolders(client: ImapFlow, mailboxes: ServerMailbox[], roles: Roles, dry: boolean): Promise<void> {
    const deleted = new Set(
      (sqlite.prepare('SELECT imap_folder AS f FROM imap_deleted_folders').all() as { f: string }[]).map((r) => r.f)
    )
    const special = new Set([roles.inbox, roles.junk, roles.trash].filter(Boolean) as string[])
    const folders = q.folders()
    const mapped = new Set(folders.filter((f) => f.imapFolder).map((f) => f.imapFolder!))
    const existing = new Set(mailboxes.map((m) => m.path))

    // Server -> Meremail: new mailboxes become folders
    for (const m of mailboxes) {
      if (special.has(m.path) || roles.passive.has(m.path) || mapped.has(m.path) || deleted.has(m.path)) continue
      if (m.specialUse && IGNORED_SPECIAL.has(m.specialUse)) continue
      if ((m as { flags?: Set<string> }).flags?.has('\\Noselect')) continue
      const name = lastSegment(m.path, m.delimiter || roles.delimiter)
      log(`${dry ? '[dry-run] Would create' : 'Creating'} folder "${name}" for server folder ${m.path}`)
      if (dry) continue
      const pos = (sqlite.prepare('SELECT MAX(position) AS p FROM folders').get() as { p: number | null }).p || 0
      sqlite
        .prepare(
          `INSERT INTO folders (name, imap_folder, position, is_system, notifications_enabled, show_unread_count, sync_offline, created_at)
           VALUES (?, ?, ?, 0, 0, 1, 1, ?)`
        )
        .run(name, m.path, pos + 1, nowSeconds())
    }

    for (const f of folders) {
      if (f.isSystem) continue
      // Meremail -> server: new folders become mailboxes
      if (!f.imapFolder) {
        const path = `${roles.prefix}${f.name.replaceAll(roles.delimiter, ' ')}`
        log(`${dry ? '[dry-run] Would create' : 'Creating'} server folder ${path} for "${f.name}"`)
        if (dry) continue
        if (!existing.has(path)) await client.mailboxCreate(path)
        sqlite.prepare('UPDATE folders SET imap_folder = ? WHERE id = ?').run(path, f.id)
        continue
      }
      // Renamed in Meremail -> rename on the server
      if (existing.has(f.imapFolder) && lastSegment(f.imapFolder, roles.delimiter) !== f.name) {
        const parent = f.imapFolder.slice(0, f.imapFolder.length - lastSegment(f.imapFolder, roles.delimiter).length)
        const path = `${parent}${f.name.replaceAll(roles.delimiter, ' ')}`
        if (existing.has(path)) continue
        log(`${dry ? '[dry-run] Would rename' : 'Renaming'} server folder ${f.imapFolder} to ${path}`)
        if (dry) continue
        await client.mailboxRename(f.imapFolder, path)
        sqlite.transaction(() => {
          sqlite.prepare('UPDATE folders SET imap_folder = ? WHERE id = ?').run(path, f.id)
          sqlite.prepare('UPDATE email_imap_locations SET imap_folder = ? WHERE imap_folder = ?').run(path, f.imapFolder)
        })()
      }
    }
  }

  /** Delete on the server what was deleted in Meremail */
  private async processDeletes(client: ImapFlow, roles: Roles, dry: boolean): Promise<void> {
    const pending = sqlite
      .prepare('SELECT id, message_id AS messageId, imap_folder AS folder, uid, uid_validity AS uidValidity FROM imap_pending_deletes ORDER BY imap_folder')
      .all() as { id: number; messageId: string; folder: string; uid: number | null; uidValidity: number | null }[]
    if (pending.length === 0) return
    log(`${dry ? '[dry-run] Would delete' : 'Deleting'} ${pending.length} message(s) on the server`)
    if (dry) return

    const byFolder = new Map<string, typeof pending>()
    for (const p of pending) byFolder.set(p.folder, [...(byFolder.get(p.folder) || []), p])

    for (const [folder, items] of byFolder) {
      try {
        const box = await client.mailboxOpen(folder)
        const uidValidity = Number(box.uidValidity)
        const uids: number[] = []
        for (const item of items) {
          // Check the UID still holds this message before deleting it
          if (item.uid && item.uidValidity === uidValidity) {
            const match = await this.messageIdAt(client, item.uid)
            if (match === item.messageId) {
              uids.push(item.uid)
              continue
            }
          }
          const found = await client.search({ header: { 'message-id': item.messageId } }, { uid: true })
          if (found && found.length) uids.push(...found)
        }
        if (uids.length) await client.messageDelete(uids, { uid: true })
        const del = sqlite.prepare('DELETE FROM imap_pending_deletes WHERE id = ?')
        sqlite.transaction(() => items.forEach((i) => del.run(i.id)))()
      } catch (error) {
        const missing = /nonexistent|doesn't exist|not exist|NONEXISTENT/i.test(String(error))
        if (missing) {
          sqlite.prepare('DELETE FROM imap_pending_deletes WHERE imap_folder = ?').run(folder)
        } else {
          console.error(`[ImapSync] Error deleting in ${folder}:`, error)
        }
      }
    }
  }

  private async messageIdAt(client: ImapFlow, uid: number): Promise<string | undefined> {
    const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true })
    return msg ? msg.envelope?.messageId : undefined
  }

  /**
   * Find where every tracked email is on the server now, and import mail that
   * Meremail has never seen. Returns emailId -> where it is, or null if the
   * scan failed and nothing should be decided this pass.
   */
  private async scan(
    client: ImapFlow,
    folders: string[],
    roles: Roles,
    imapToFolder: Map<string, number>,
    dry: boolean
  ): Promise<Map<number, Seen> | null> {
    const locations = q.locations()
    const byFolder = new Map<string, Location[]>()
    for (const l of locations) byFolder.set(l.folder, [...(byFolder.get(l.folder) || []), l])

    const seen = new Map<number, Seen>()
    const unknown: { folder: string; uid: number; uidValidity: number }[] = []

    for (const folder of folders) {
      let box
      try {
        box = await client.mailboxOpen(folder, { readOnly: true })
      } catch (error) {
        console.error(`[ImapSync] Cannot open ${folder}, skipping this pass:`, error)
        return null
      }
      const uidValidity = Number(box.uidValidity)
      const uids = box.exists ? ((await client.search({ all: true }, { uid: true })) || []) : []
      const known = new Map<number, Location>()
      for (const l of byFolder.get(folder) || []) {
        if (l.uid != null && l.uidValidity === uidValidity) known.set(l.uid, l)
      }
      for (const uid of uids) {
        const l = known.get(uid)
        if (l) seen.set(l.emailId, { folder, uid, uidValidity })
        else unknown.push({ folder, uid, uidValidity })
      }
    }

    // Identify the messages whose UID we don't know yet by Message-ID
    const byUnknownFolder = new Map<string, typeof unknown>()
    for (const u of unknown) byUnknownFolder.set(u.folder, [...(byUnknownFolder.get(u.folder) || []), u])

    const toImport: { folder: string; uid: number }[] = []
    for (const [folder, items] of byUnknownFolder) {
      await client.mailboxOpen(folder, { readOnly: true })
      const uidValidity = items[0]!.uidValidity
      for (let i = 0; i < items.length; i += FETCH_BATCH) {
        const batch = items.slice(i, i + FETCH_BATCH).map((x) => x.uid)
        for await (const msg of client.fetch(batch, { uid: true, envelope: true }, { uid: true })) {
          const messageId = msg.envelope?.messageId
          if (!messageId) continue
          const email = q.emailByMessageId.get(messageId) as { id: number; threadId: number } | undefined
          if (email) {
            const prev = seen.get(email.id)
            // The same message in two folders: keep the copy outside passive folders
            if (!prev || (roles.passive.has(prev.folder) && !roles.passive.has(folder))) {
              seen.set(email.id, { folder, uid: msg.uid, uidValidity })
            }
          } else if (!q.isForgotten.get(messageId) && (imapToFolder.has(folder) || roles.sent.has(folder))) {
            toImport.push({ folder, uid: msg.uid })
          }
        }
      }
    }

    if (toImport.length) {
      log(`${dry ? '[dry-run] Would import' : 'Importing'} ${toImport.length} new message(s) from the server`)
      if (!dry) await this.importMessages(client, toImport, imapToFolder, seen)
    }
    return seen
  }

  private async importMessages(
    client: ImapFlow,
    items: { folder: string; uid: number }[],
    imapToFolder: Map<string, number>,
    seen: Map<number, Seen>
  ): Promise<void> {
    const byFolder = new Map<string, number[]>()
    for (const i of items) byFolder.set(i.folder, [...(byFolder.get(i.folder) || []), i.uid])
    for (const [folder, uids] of byFolder) {
      const box = await client.mailboxOpen(folder, { readOnly: true })
      const uidValidity = Number(box.uidValidity)
      const target = imapToFolder.get(folder)
      for (let i = 0; i < uids.length; i += 50) {
        for await (const message of client.fetch(uids.slice(i, i + 50), { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
          if (!message.source) continue
          try {
            const parsed = await simpleParser(message.source, { skipImageLinks: true })
            const fetched = {
              uid: message.uid,
              folder,
              parsed,
              raw: message.source,
              flags: message.flags ?? new Set<string>(),
              internalDate: toDate(message.internalDate),
            }
            backupEml(fetched)
            const importable = toImportableEmail(fetched)
            if (target !== undefined && target !== JUNK_FOLDER_ID) importable.folderId = target
            await importEmail(importable)
            const email = parsed.messageId
              ? (q.emailByMessageId.get(parsed.messageId) as { id: number; threadId: number } | undefined)
              : undefined
            if (!email) continue
            seen.set(email.id, { folder, uid: message.uid, uidValidity })
            const thread = q.thread.get(email.threadId) as { id: number; folderId: number }
            if (thread.folderId === TRASH_FOLDER_ID) {
              sqlite.prepare('UPDATE email_threads SET trashed_at = COALESCE(trashed_at, ?) WHERE id = ?').run(nowSeconds(), thread.id)
            }
          } catch (error) {
            console.error(`[ImapSync] Error importing ${folder} UID ${message.uid}:`, error)
          }
        }
      }
    }
  }

  /** Decide, thread by thread, which side moved and bring the other one in line */
  private async reconcile(
    client: ImapFlow,
    seen: Map<number, Seen>,
    roles: Roles,
    folderToImap: Map<number, string>,
    imapToFolder: Map<string, number>,
    dry: boolean
  ): Promise<void> {
    const locations = new Map(q.locations().map((l) => [l.emailId, l]))
    const threadIds = new Set<number>()
    const threadOfEmail = sqlite.prepare('SELECT thread_id AS t FROM emails WHERE id = ?')
    for (const emailId of new Set([...seen.keys(), ...locations.keys()])) {
      const row = threadOfEmail.get(emailId) as { t: number | null } | undefined
      if (row?.t) threadIds.add(row.t)
    }

    const serverMoves: { emailId: number; from: Seen; to: string }[] = []
    let movedLocally = 0

    for (const threadId of threadIds) {
      const thread = q.thread.get(threadId) as { id: number; folderId: number } | undefined
      if (!thread) continue
      const emailRows = q.threadEmails.all(threadId) as { id: number; messageId: string | null; at: number }[]
      const active = emailRows.filter((e) => {
        const s = seen.get(e.id)
        return s && !roles.passive.has(s.folder)
      })

      let base = (q.threadSync.get(threadId) as { f: number } | undefined)?.f
      if (base === undefined) {
        // First time we see this thread: the server's view is the baseline,
        // so a rule that filed it elsewhere on import is carried to the server
        const latest = [...active].sort((a, b) => b.at - a.at)[0]
        const at = latest ? imapToFolder.get(seen.get(latest.id)!.folder) : undefined
        base = at ?? thread.folderId
        if (!dry) q.setThreadSync.run(threadId, base)
      }

      const serverChanged = active.filter((e) => {
        const l = locations.get(e.id)
        return l && l.folder !== seen.get(e.id)!.folder
      })
      const gone = emailRows.filter((e) => locations.has(e.id) && !seen.has(e.id))
      const localChanged = thread.folderId !== base

      if (localChanged) {
        const target = folderToImap.get(thread.folderId)
        if (target) {
          for (const e of active) {
            const s = seen.get(e.id)!
            if (s.folder !== target) serverMoves.push({ emailId: e.id, from: s, to: target })
          }
        }
        if (!dry) q.setThreadSync.run(threadId, thread.folderId)
      } else if (serverChanged.length || (gone.length && active.length === 0)) {
        let target: number | undefined
        if (serverChanged.length) {
          const latest = [...serverChanged].sort((a, b) => b.at - a.at)[0]!
          target = imapToFolder.get(seen.get(latest.id)!.folder)
        } else {
          target = TRASH_FOLDER_ID // deleted on the server
        }
        if (target !== undefined && target !== thread.folderId) {
          log(`${dry ? '[dry-run] Would move' : 'Moving'} thread ${threadId} to folder ${target} (changed on server)`)
          if (!dry) moveThreadLocally(threadId, target)
          movedLocally++
        }
        if (!dry) q.setThreadSync.run(threadId, target ?? thread.folderId)
      }
    }

    if (!dry) {
      sqlite.transaction(() => {
        for (const [emailId, s] of seen) q.upsertLocation.run(emailId, s.folder, s.uid, s.uidValidity)
        for (const emailId of locations.keys()) if (!seen.has(emailId)) q.deleteLocation.run(emailId)
      })()
    }

    if (serverMoves.length) {
      const counts = new Map<string, number>()
      for (const m of serverMoves) counts.set(`${m.from.folder} -> ${m.to}`, (counts.get(`${m.from.folder} -> ${m.to}`) || 0) + 1)
      const summary = [...counts].map(([k, n]) => `${k}: ${n}`).join(', ')
      log(`${dry ? '[dry-run] Would move' : 'Moving'} ${serverMoves.length} message(s) on the server (${summary})`)
      if (!dry) await this.moveOnServer(client, serverMoves)
    }
    if (movedLocally) log(`${dry ? '[dry-run] ' : ''}${movedLocally} thread(s) followed server moves`)
  }

  private async moveOnServer(client: ImapFlow, moves: { emailId: number; from: Seen; to: string }[]): Promise<void> {
    const groups = new Map<string, typeof moves>()
    for (const m of moves) {
      const key = `${m.from.folder}\u0000${m.to}`
      groups.set(key, [...(groups.get(key) || []), m])
    }
    for (const items of groups.values()) {
      const { folder } = items[0]!.from
      const to = items[0]!.to
      try {
        await client.mailboxOpen(folder)
        const result = await client.messageMove(items.map((i) => i.from.uid), to, { uid: true })
        const map = result && typeof result === 'object' ? (result as { uidMap?: Map<number, number>; uidValidity?: bigint }).uidMap : undefined
        const destValidity = result && typeof result === 'object' ? Number((result as { uidValidity?: bigint }).uidValidity ?? 0) : 0
        sqlite.transaction(() => {
          for (const i of items) {
            const uid = map?.get(i.from.uid) ?? null
            q.upsertLocation.run(i.emailId, to, uid, uid != null ? destValidity : null)
          }
        })()
      } catch (error) {
        console.error(`[ImapSync] Error moving ${items.length} message(s) from ${folder} to ${to}:`, error)
      }
    }
  }

  /** Remove server folders whose Meremail folder was deleted, once empty */
  private async processDeletedFolders(client: ImapFlow, dry: boolean): Promise<void> {
    const rows = sqlite.prepare('SELECT imap_folder AS f FROM imap_deleted_folders').all() as { f: string }[]
    for (const { f } of rows) {
      try {
        const status = await client.status(f, { messages: true })
        if ((status.messages ?? 0) > 0) continue
        log(`${dry ? '[dry-run] Would delete' : 'Deleting'} empty server folder ${f}`)
        if (dry) continue
        await client.mailboxDelete(f)
        sqlite.prepare('DELETE FROM imap_deleted_folders WHERE imap_folder = ?').run(f)
      } catch (error) {
        if (/nonexistent|doesn't exist|not exist/i.test(String(error))) {
          if (!dry) sqlite.prepare('DELETE FROM imap_deleted_folders WHERE imap_folder = ?').run(f)
        } else {
          console.error(`[ImapSync] Error deleting server folder ${f}:`, error)
        }
      }
    }
  }
}

const imapSync = new ImapSync()

export function startImapSync(): void {
  imapSync.start()
}

export function stopImapSync(): void {
  imapSync.stop()
}

export function requestImapSync(): void {
  imapSync.request()
}
