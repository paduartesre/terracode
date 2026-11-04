import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FileExplorer from './FileExplorer'

// Mock the API module
vi.mock('./api', () => ({
  listDir: vi.fn(),
  getGitStatus: vi.fn(),
  listRoots: vi.fn(),
  openFolder: vi.fn(),
  removeRoot: vi.fn(),
  renameEntry: vi.fn(),
  deleteEntry: vi.fn(),
  createEntry: vi.fn(),
  searchFiles: vi.fn(),
  replaceInFile: vi.fn()
}))

import { listDir, getGitStatus, listRoots } from './api'

describe('FileExplorer Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listDir as any).mockResolvedValue([])
    ;(getGitStatus as any).mockResolvedValue({ isRepo: false, entries: [] })
    ;(listRoots as any).mockResolvedValue({ roots: ['/home/user'], removableRoots: [] })
  })

  it('should render with default root path', () => {
    render(<FileExplorer onSelectFile={vi.fn()} />)
    expect(screen.getByText(/Root:/)).toBeInTheDocument()
  })

  it('should show loading state initially', async () => {
    ;(listDir as any).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 100)))
    render(<FileExplorer onSelectFile={vi.fn()} />)
    expect(screen.getByText(/Loading…/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/Loading…/)).not.toBeInTheDocument())
  })

  it('should display directory entries', async () => {
    const entries = [
      { name: 'src', path: '/root/src', isDirectory: true },
      { name: 'package.json', path: '/root/package.json', isDirectory: false }
    ]
    ;(listDir as any).mockResolvedValue(entries)

    render(<FileExplorer onSelectFile={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument()
      expect(screen.getByText('package.json')).toBeInTheDocument()
    })
  })

  it('should call onSelectFile when a file is clicked', async () => {
    const entries = [{ name: 'file.txt', path: '/root/file.txt', isDirectory: false }]
    ;(listDir as any).mockResolvedValue(entries)
    const onSelectFile = vi.fn()

    render(<FileExplorer onSelectFile={onSelectFile} />)

    await waitFor(() => {
      fireEvent.click(screen.getByText('file.txt'))
    })

    expect(onSelectFile).toHaveBeenCalledWith('/root/file.txt')
  })

  it('should expand folder when clicked', async () => {
    const entries = [{ name: 'folder', path: '/root/folder', isDirectory: true }]
    ;(listDir as any)
      .mockResolvedValueOnce(entries) // root listing
      .mockResolvedValueOnce([{ name: 'inner.txt', path: '/root/folder/inner.txt', isDirectory: false }]) // folder contents

    render(<FileExplorer onSelectFile={vi.fn()} />)

    await waitFor(() => {
      fireEvent.click(screen.getByText('folder'))
    })

    await waitFor(() => {
      expect(screen.getByText('inner.txt')).toBeInTheDocument()
    })
  })

  it('should show search input', () => {
    render(<FileExplorer onSelectFile={vi.fn()} />)
    const searchInput = screen.getByPlaceholderText(/Search files and contents/)
    expect(searchInput).toBeInTheDocument()
  })

  it('should display recent files when provided', async () => {
    ;(listDir as any).mockResolvedValue([])
    render(<FileExplorer onSelectFile={vi.fn()} recentFiles={['/root/recent.txt']} />)

    await waitFor(() => {
      expect(screen.getByText(/Recent/)).toBeInTheDocument()
    })
  })

  it('should show error state when loading fails', async () => {
    ;(listDir as any).mockRejectedValue(new Error('Network error'))

    render(<FileExplorer onSelectFile={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument()
    })
  })
})
