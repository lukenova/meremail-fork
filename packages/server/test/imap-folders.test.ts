import { describe, it, expect, beforeAll } from 'vitest'
import { sqlite, folderIdForImapFolder, mappedImapFolders } from '@meremail/shared'
import { setupDatabase, receive } from './helpers'

function threadFolder(threadId: number): number {
  return (sqlite.prepare('SELECT folder_id AS f FROM email_threads WHERE id = ?').get(threadId) as { f: number }).f
}

describe('IMAP folder mapping', () => {
  let amazon: number

  beforeAll(() => {
    setupDatabase()
    amazon = Number(
      sqlite
        .prepare("INSERT INTO folders (name, imap_folder, position, is_system, created_at) VALUES ('Amazon', 'INBOX.Amazon', 10, 0, 0)")
        .run().lastInsertRowid
    )
  })

  it('finds the custom folder mapped to an IMAP folder', () => {
    expect(folderIdForImapFolder('INBOX.Amazon')).toBe(amazon)
    expect(folderIdForImapFolder('INBOX.Other')).toBeUndefined()
  })

  it('leaves system folders out of the mapping', () => {
    expect(folderIdForImapFolder('INBOX')).toBeUndefined()
    expect(mappedImapFolders()).toEqual(['INBOX.Amazon'])
  })

  it('files a new thread in the mapped folder', async () => {
    const { threadId } = await receive({ folderId: amazon })
    expect(threadFolder(threadId)).toBe(amazon)
  })

  it('still sends junk to Junk', async () => {
    const { threadId } = await receive({ folderId: amazon, isJunk: true })
    expect(threadFolder(threadId)).toBe(2)
  })

  it('defaults to Inbox without a mapping', async () => {
    const { threadId } = await receive()
    expect(threadFolder(threadId)).toBe(1)
  })
})
