import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listDir, readFileContent, saveFileContent, searchFiles, replaceInFile,
  createEntry, renameEntry, deleteEntry, listRoots, openFolder, removeRoot,
  runTerraform, getTfVersions, setTfVersion, installTfVersion, getTfStateInfo,
  listTfVarFiles, getCloudStatus, cloudCredentialAction, cloudLogin, cloudLogout,
  getGitStatus, getGitFileDiff, getGitLog, getGitCommitDiff, gitCommit,
  getGitBranches, getGitRemotes, createBranch, checkoutBranch, mergeBranch,
  rebaseOnto, rebaseStep, initRepo, gitPush, gitPull, gitFetch
} from './api'

const API_BASE = 'http://localhost:3001'

function mockFetch(response: any, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    body: null
  } as any)
}

describe('API Layer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('File Operations', () => {
    it('listDir should fetch directory listing', async () => {
      const entries = [{ name: 'file.txt', path: '/root/file.txt', isDirectory: false }]
      mockFetch(entries)
      const result = await listDir('/root')
      expect(result).toEqual(entries)
      expect(globalThis.fetch).toHaveBeenCalledWith(`${API_BASE}/api/files?path=%2Froot`)
    })

    it('readFileContent should fetch file content', async () => {
      const data = { path: '/root/file.txt', content: 'hello', mtimeMs: 123 }
      mockFetch(data)
      const result = await readFileContent('/root/file.txt')
      expect(result).toEqual(data)
    })

    it('saveFileContent should PUT file content with conflict detection', async () => {
      const result = { path: '/root/file.txt', mtimeMs: 456, size: 10 }
      mockFetch(result)
      await saveFileContent('/root/file.txt', 'new content', 123)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/file-content`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ path: '/root/file.txt', content: 'new content', mtimeMs: 123 })
        })
      )
    })

    it('createEntry should POST new file or directory', async () => {
      mockFetch({ name: 'newfile.txt', path: '/root/newfile.txt', isDirectory: false })
      await createEntry('/root/newfile.txt', 'file')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/files`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/root/newfile.txt', type: 'file' })
        })
      )
    })

    it('renameEntry should POST rename operation', async () => {
      mockFetch({ name: 'renamed.txt', path: '/root/renamed.txt', isDirectory: false })
      await renameEntry('/root/old.txt', '/root/new.txt')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/rename`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ from: '/root/old.txt', to: '/root/new.txt' })
        })
      )
    })

    it('deleteEntry should DELETE entry', async () => {
      mockFetch({ deleted: '/root/file.txt' })
      await deleteEntry('/root/file.txt')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/files?path=%2Froot%2Ffile.txt`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('Search Operations', () => {
    it('searchFiles should search with basic query', async () => {
      mockFetch([])
      await searchFiles('test', '/root')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/search?q=test&path=%2Froot`
      )
    })

    it('searchFiles should include regex option when specified', async () => {
      mockFetch([])
      await searchFiles('test**pattern', '/root', { regex: true })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/search?q=test%2A%2Apattern&path=%2Froot&regex=1`
      )
    })

    it('searchFiles should include caseSensitive option when specified', async () => {
      mockFetch([])
      await searchFiles('Test', '/root', { caseSensitive: true })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/search?q=Test&path=%2Froot&case=1`
      )
    })

    it('searchFiles should include ext filter when specified', async () => {
      mockFetch([])
      await searchFiles('test', '/root', { ext: 'ts,tsx' })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/search?q=test&path=%2Froot&ext=ts%2Ctsx`
      )
    })

    it('replaceInFile should POST replace operation with conflict detection', async () => {
      mockFetch({ replaced: 3, path: '/root/file.txt', mtimeMs: 789 })
      await replaceInFile('/root/file.txt', 'old', 'new', 123)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/replace`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            path: '/root/file.txt', find: 'old', replacement: 'new', mtimeMs: 123, regex: false, caseSensitive: false
          })
        })
      )
    })
  })

  describe('Root Management', () => {
    it('listRoots should fetch allowed roots', async () => {
      mockFetch({ roots: ['/root'], removableRoots: [] })
      const result = await listRoots()
      expect(result.roots).toEqual(['/root'])
    })

    it('openFolder should POST new root', async () => {
      mockFetch({ roots: ['/root', '/new'] })
      await openFolder('/new')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/roots`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/new' })
        })
      )
    })

    it('removeRoot should DELETE root', async () => {
      mockFetch({ roots: ['/root'] })
      await removeRoot('/old')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/roots?path=%2Fold`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('Terraform Operations', () => {
    it('runTerraform should POST terraform command', async () => {
      mockFetch({ command: 'plan', exitCode: 0, output: '', timedOut: false })
      await runTerraform('plan', '/root')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/tf/run`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: 'plan', path: '/root' })
        })
      )
    })

    it('runTerraform should include options when provided', async () => {
      mockFetch({ command: 'init', exitCode: 0, output: '', timedOut: false })
      await runTerraform('init', '/root', { varFile: 'dev.tfvars' })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/tf/run`,
        expect.objectContaining({
          body: JSON.stringify({ command: 'init', path: '/root', varFile: 'dev.tfvars' })
        })
      )
    })

    it('getTfVersions should fetch terraform versions', async () => {
      mockFetch({ tfenvAvailable: true, installed: ['1.5.0'], active: '1.5.0' })
      const result = await getTfVersions('/root')
      expect(result.installed).toEqual(['1.5.0'])
    })

    it('setTfVersion should POST version pin', async () => {
      mockFetch({ path: '/root/.terraform-version', version: '1.6.0' })
      await setTfVersion('/root', '1.6.0')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/tf/version`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/root', version: '1.6.0' })
        })
      )
    })

    it('installTfVersion should POST install request', async () => {
      mockFetch({ exitCode: 0, output: '', timedOut: false })
      await installTfVersion('1.7.0')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/tf/install`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ version: '1.7.0' })
        })
      )
    })

    it('getTfStateInfo should fetch state info', async () => {
      mockFetch({ initialized: true, backend: null, localState: { exists: true, resources: 5 } })
      const result = await getTfStateInfo('/root')
      expect(result.initialized).toBe(true)
    })

    it('listTfVarFiles should list var files', async () => {
      mockFetch({ files: [{ name: 'terraform.tfvars', autoLoaded: true }] })
      const result = await listTfVarFiles('/root')
      expect(result.files).toHaveLength(1)
    })
  })

  describe('Cloud Operations', () => {
    it('getCloudStatus should fetch cloud status', async () => {
      mockFetch({ exists: false, providers: [], unlocked: false, sessions: {} })
      const result = await getCloudStatus()
      expect(result.exists).toBe(false)
    })

    it('cloudCredentialAction should POST credential action', async () => {
      mockFetch({ ok: true, exists: true, providers: ['aws'], unlocked: true, sessions: {} })
      await cloudCredentialAction('create', { passphrase: 'secret' })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/cloud/credentials`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'create', passphrase: 'secret' })
        })
      )
    })

    it('cloudLogin should POST login request', async () => {
      mockFetch({ ok: true, provider: 'aws', session: { loggedInAt: 123 } })
      const result = await cloudLogin('aws')
      expect(result.provider).toBe('aws')
    })

    it('cloudLogout should POST logout request', async () => {
      mockFetch({ ok: true, provider: 'aws' })
      await cloudLogout('aws')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/cloud/logout`,
        expect.objectContaining({ body: JSON.stringify({ provider: 'aws' }) })
      )
    })
  })

  describe('Git Operations', () => {
    it('getGitStatus should fetch git status', async () => {
      mockFetch({ isRepo: true, entries: [] })
      const result = await getGitStatus('/root')
      expect(result.isRepo).toBe(true)
    })

    it('getGitFileDiff should fetch file diff', async () => {
      mockFetch({ path: '/root/file.txt', oldContent: 'old', newContent: 'new', untracked: false })
      const result = await getGitFileDiff('/root', 'file.txt')
      expect(result.oldContent).toBe('old')
    })

    it('getGitLog should fetch commit log with limit', async () => {
      mockFetch({ isRepo: true, commits: [] })
      await getGitLog('/root', 10)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/log?path=%2Froot&limit=10`
      )
    })

    it('getGitCommitDiff should fetch commit diff', async () => {
      mockFetch({ hash: 'abc123', files: [], truncated: false })
      const result = await getGitCommitDiff('/root', 'abc123')
      expect(result.hash).toBe('abc123')
    })

    it('gitCommit should POST commit with all files by default', async () => {
      mockFetch({ committed: true, hash: 'def456' })
      await gitCommit('/root', 'test message')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/commit`,
        expect.objectContaining({
          body: JSON.stringify({ path: '/root', message: 'test message' })
        })
      )
    })

    it('gitCommit should POST commit with specific files when provided', async () => {
      mockFetch({ committed: true, hash: 'def456' })
      await gitCommit('/root', 'test message', ['file1.txt', 'file2.txt'])
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/commit`,
        expect.objectContaining({
          body: JSON.stringify({ path: '/root', message: 'test message', files: ['file1.txt', 'file2.txt'] })
        })
      )
    })

    it('getGitBranches should fetch branches', async () => {
      mockFetch({ isRepo: true, current: 'main', branches: ['main', 'dev'] })
      const result = await getGitBranches('/root')
      expect(result.current).toBe('main')
    })

    it('getGitRemotes should fetch remotes with platform detection', async () => {
      mockFetch({ isRepo: true, remotes: [{ name: 'origin', url: 'https://github.com/user/repo.git', platform: 'github' }] })
      const result = await getGitRemotes('/root')
      expect(result.remotes[0].platform).toBe('github')
    })

    it('createBranch should POST branch creation with switch option', async () => {
      mockFetch({ created: 'feature', switched: true })
      await createBranch('/root', 'feature', { switch: true })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/branch`,
        expect.objectContaining({
          body: JSON.stringify({ path: '/root', name: 'feature', from: undefined, switch: true })
        })
      )
    })

    it('checkoutBranch should POST checkout request', async () => {
      mockFetch({ checkedOut: 'dev' })
      await checkoutBranch('/root', 'dev')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/checkout`,
        expect.objectContaining({ body: JSON.stringify({ path: '/root', ref: 'dev' }) })
      )
    })

    it('mergeBranch should POST merge request', async () => {
      mockFetch({ merged: true, branch: 'feature', output: '' })
      await mergeBranch('/root', 'feature')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/merge`,
        expect.objectContaining({ body: JSON.stringify({ path: '/root', branch: 'feature' }) })
      )
    })

    it('rebaseOnto should POST rebase request', async () => {
      mockFetch({ rebased: true, branch: 'main', output: '' })
      await rebaseOnto('/root', 'main')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/rebase`,
        expect.objectContaining({ body: JSON.stringify({ path: '/root', branch: 'main' }) })
      )
    })

    it('rebaseStep should POST rebase step action', async () => {
      mockFetch({ action: 'continue', done: true, output: '' })
      await rebaseStep('/root', 'continue')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/rebase-step`,
        expect.objectContaining({ body: JSON.stringify({ path: '/root', action: 'continue' }) })
      )
    })

    it('initRepo should POST repo initialization with remote option', async () => {
      mockFetch({ initialized: true, branch: 'main' })
      await initRepo('/root', { remoteUrl: 'https://github.com/user/repo.git' })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/init`,
        expect.objectContaining({
          body: JSON.stringify({ path: '/root', remoteUrl: 'https://github.com/user/repo.git', branch: undefined })
        })
      )
    })

    it('gitPush should POST push request with upstream option', async () => {
      mockFetch({ success: true, output: '' })
      await gitPush('/root', { setUpstream: true })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/push`,
        expect.objectContaining({
          body: JSON.stringify({ path: '/root', branch: undefined, setUpstream: true })
        })
      )
    })

    it('gitPull should POST pull request', async () => {
      mockFetch({ success: true, output: '' })
      await gitPull('/root')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/pull`,
        expect.objectContaining({ body: JSON.stringify({ path: '/root', branch: undefined }) })
      )
    })

    it('gitFetch should POST fetch request', async () => {
      mockFetch({ success: true, output: '' })
      await gitFetch('/root')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE}/api/git/fetch`,
        expect.objectContaining({ body: JSON.stringify({ path: '/root' }) })
      )
    })
  })

  describe('Error Handling', () => {
    it('should throw error with status code on non-OK response', async () => {
      mockFetch(null, 500)
      await expect(listDir('/root')).rejects.toThrow('Request failed (500)')
    })

    it('should extract error message from JSON response body', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Access denied' }),
        body: null
      } as any)
      await expect(listDir('/root')).rejects.toThrow('Access denied')
    })

    it('should handle non-JSON error bodies gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => { throw new Error('Not JSON') },
        body: null
      } as any)
      await expect(listDir('/root')).rejects.toThrow('Request failed (502)')
    })
  })
})
