/**
 * Two-way IMAP sync against a real IMAP server. Skipped unless
 * IMAP_TEST_HOST is set, e.g. a throwaway Dovecot:
 *
 *   IMAP_TEST_HOST=127.0.0.1 IMAP_TEST_PORT=10143 IMAP_TEST_USER=test IMAP_TEST_PASS=pass pnpm -F @meremail/server test
 *
 * The test account's mailbox is emptied first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sqlite, deleteThread, deleteThreads, createImapClient, config } from '@meremail/shared'
import { setupDatabase } from './helpers'
import { ImapSync } from '../src/services/imap-sync'

const host = process.env.IMAP_TEST_HOST
const run = host ? describe : describe.skip

type ImapFlow = Awaited<ReturnType<typeof createImapClient>>

async function connect(): Promise<ImapFlow> {
  Object.assign(config.imap, {
    host: host!,
    port: Number(process.env.IMAP_TEST_PORT || 143),
    secure: process.env.IMAP_TEST_SECURE === 'true',
    user: process.env.IMAP_TEST_USER || 'test',
    pass: process.env.IMAP_TEST_PASS || 'pass',
  })
  const c = await createImapClient()
  c.on('error', () => {})
  return c
}

function raw(id: string, subject: string, opts: { from?: string; inReplyTo?: string } = {}): string {
  return [
    `From: ${opts.from || 'Alice <alice@example.com>'}`,
    'To: Me <me@example.com>',
    `Subject: ${subject}`,
    `Message-ID: <${id}@test>`,
    ...(opts.inReplyTo ? [`In-Reply-To: <${opts.inReplyTo}@test>`, `References: <${opts.inReplyTo}@test>`] : []),
    'Date: Mon, 02 Nov 2026 10:00:00 +0000',
    '',
    `Body of ${subject}`,
    '',
  ].join('\r\n')
}

async function where(c: ImapFlow, id: string): Promise<string[]> {
  const found: string[] = []
  for (const box of await c.list()) {
    if ((box.flags as Set<string>)?.has('\\Noselect')) continue
    await c.mailboxOpen(box.path, { readOnly: true })
    const r = await c.search({ header: { 'message-id': `<${id}@test>` } }, { uid: true })
    if (r && r.length) found.push(box.path)
  }
  return found
}

function threadOf(id: string): { id: number; folder: string } | undefined {
  return sqlite
    .prepare(
      `SELECT t.id, f.name AS folder FROM emails e JOIN email_threads t ON t.id = e.thread_id
       JOIN folders f ON f.id = t.folder_id WHERE e.message_id = ?`
    )
    .get(`<${id}@test>`) as { id: number; folder: string } | undefined
}

function folderId(name: string): number {
  return (sqlite.prepare('SELECT id FROM folders WHERE name = ?').get(name) as { id: number }).id
}

function moveLocally(threadId: number, folder: number): void {
  if (folder === 3) {
    sqlite.prepare('UPDATE email_threads SET previous_folder_id = folder_id, folder_id = 3, trashed_at = 1 WHERE id = ?').run(threadId)
  } else {
    sqlite.prepare('UPDATE email_threads SET folder_id = ?, previous_folder_id = NULL, trashed_at = NULL WHERE id = ?').run(folder, threadId)
  }
}

run('two-way IMAP sync', { timeout: 30000 }, () => {
  let c: ImapFlow
  const sync = new ImapSync(() => 'on')
  const pass = async () => {
    const s = await connect()
    try {
      await sync.syncWith(s)
    } finally {
      await s.logout()
    }
  }

  beforeAll(async () => {
    setupDatabase()
    c = await connect()
    // Start from an empty account with the usual folders
    for (const box of [...(await c.list())].reverse()) {
      if (box.path.toUpperCase() === 'INBOX' || box.specialUse) {
        await c.mailboxOpen(box.path)
        await c.messageDelete('1:*').catch(() => {})
      } else {
        await c.mailboxDelete(box.path).catch(() => {})
      }
    }
    await c.mailboxCreate('INBOX.Amazon')
    await c.append('INBOX', raw('m1', 'Dinner'))
    await c.append('INBOX', raw('m2', 'Invoice'))
    await c.append('INBOX.Amazon', raw('m3', 'Your order'))
    await c.append('Trash', raw('m4', 'Old news'))
    await c.append('Sent', raw('s1', 'Re: Dinner', { from: 'Me <me@example.com>', inReplyTo: 'm1' }), ['\\Seen'])
  })

  afterAll(async () => {
    await c?.logout()
  })

  it('imports the server and mirrors its folders', async () => {
    await pass()
    expect(threadOf('m1')?.folder).toBe('Inbox')
    expect(threadOf('s1')?.id).toBe(threadOf('m1')?.id)
    expect(threadOf('m3')?.folder).toBe('Amazon')
    expect(threadOf('m4')?.folder).toBe('Trash')
  })

  it('is stable when nothing changed', async () => {
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM email_imap_locations').get()
    await pass()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM email_imap_locations').get()).toEqual(before)
    expect(await where(c, 'm2')).toEqual(['INBOX'])
  })

  it('moves messages on the server when a thread moves in Meremail', async () => {
    moveLocally(threadOf('m2')!.id, folderId('Amazon'))
    await pass()
    expect(await where(c, 'm2')).toEqual(['INBOX.Amazon'])
  })

  it('moves the thread in Meremail when another client moves the message', async () => {
    await c.mailboxOpen('INBOX.Amazon')
    await c.messageMove({ header: { 'message-id': '<m3@test>' } }, 'INBOX')
    await pass()
    expect(threadOf('m3')?.folder).toBe('Inbox')
  })

  it('creates server folders for new Meremail folders, and renames them', async () => {
    sqlite.prepare("INSERT INTO folders (name, position, is_system, created_at) VALUES ('Bills', 50, 0, 0)").run()
    await pass()
    expect((await c.list()).map((b) => b.path)).toContain('INBOX.Bills')
    moveLocally(threadOf('m3')!.id, folderId('Bills'))
    await pass()
    expect(await where(c, 'm3')).toEqual(['INBOX.Bills'])

    sqlite.prepare("UPDATE folders SET name = 'Invoices' WHERE name = 'Bills'").run()
    await pass()
    const paths = (await c.list()).map((b) => b.path)
    expect(paths).toContain('INBOX.Invoices')
    expect(paths).not.toContain('INBOX.Bills')
    expect(await where(c, 'm3')).toEqual(['INBOX.Invoices'])
  })

  it('moves to Trash on both sides', async () => {
    moveLocally(threadOf('m2')!.id, 3)
    await pass()
    expect(await where(c, 'm2')).toEqual(['Trash'])
  })

  it('deletes on the server what is deleted in Meremail, sent copies included', async () => {
    deleteThread(threadOf('m1')!.id)
    await pass()
    expect(await where(c, 'm1')).toEqual([])
    expect(await where(c, 's1')).toEqual([])
    // and does not import it again
    await pass()
    expect(threadOf('m1')).toBeUndefined()
  })

  it('moves a thread to Trash when its message is deleted on the server', async () => {
    await c.mailboxOpen('Trash')
    await c.messageDelete({ header: { 'message-id': '<m4@test>' } })
    // m4 was already in Trash; use m2's sibling case instead: delete m3 from its folder
    await c.mailboxOpen('INBOX.Invoices')
    await c.messageDelete({ header: { 'message-id': '<m3@test>' } })
    await pass()
    expect(threadOf('m3')?.folder).toBe('Trash')
  })

  it('removes the server folder when its Meremail folder is deleted', async () => {
    await c.append('INBOX', raw('m5', 'Receipt'))
    await pass()
    moveLocally(threadOf('m5')!.id, folderId('Invoices'))
    await pass()
    expect(await where(c, 'm5')).toEqual(['INBOX.Invoices'])

    const id = folderId('Invoices')
    const threads = (sqlite.prepare('SELECT id FROM email_threads WHERE folder_id = ?').all(id) as { id: number }[]).map((t) => t.id)
    deleteThreads(threads)
    sqlite.prepare('UPDATE email_threads SET previous_folder_id = NULL WHERE previous_folder_id = ?').run(id)
    sqlite.prepare('DELETE FROM folders WHERE id = ?').run(id)
    await pass()
    expect(await where(c, 'm5')).toEqual([])
    expect((await c.list()).map((b) => b.path)).not.toContain('INBOX.Invoices')
  })

  it('picks up folders and mail created by other clients', async () => {
    await c.mailboxCreate('INBOX.Projects')
    await c.append('INBOX.Projects', raw('m6', 'Kickoff'))
    await pass()
    expect(threadOf('m6')?.folder).toBe('Projects')
  })
})
