import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'

const API_BASE = 'http://localhost:3001'

describe('Terraform Integration Tests', () => {
  let serverProcess: any
  // A path the live server actually allows (root containment rejects /tmp).
  let TEST_ROOT = ''

  beforeAll(async () => {
    try {
      const res = await request(API_BASE).get('/api/roots')
      expect(res.status).toBe(200)
      TEST_ROOT = res.body.roots?.[0] ?? ''
    } catch (e) {
      console.log('Server not running, skipping integration tests')
    }
  })

  afterAll(async () => {
    // Server cleanup if we started it
  })

  describe('Terraform Command Endpoints', () => {
    it('POST /api/tf/run should validate command parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/tf/run')
        .send({ path: '/tmp' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Command')
    })

    it('POST /api/tf/run should validate path parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/tf/run')
        .send({ command: 'version' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('path')
    })

    it('POST /api/tf/run should reject unknown commands', async () => {
      const res = await request(API_BASE)
        .post('/api/tf/run')
        .send({ command: 'unknown-command', path: '/tmp' })
      expect(res.status).toBe(400)
    })

    it('GET /api/tf/versions should return version info', async () => {
      const res = await request(API_BASE)
        .get('/api/tf/versions')
        .query({ path: TEST_ROOT })
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('tfenvAvailable')
      expect(res.body).toHaveProperty('installed')
    })

    it('POST /api/tf/version should validate version parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/tf/version')
        .send({ path: '/tmp' })
      expect(res.status).toBe(400)
    })

    it('POST /api/tf/install should validate version parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/tf/install')
        .send({})
      expect(res.status).toBe(400)
    })

    it('GET /api/tf/state-info should return state info structure', async () => {
      const res = await request(API_BASE)
        .get('/api/tf/state-info')
        .query({ path: TEST_ROOT })
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('initialized')
    })

    it('GET /api/tf/var-files should return var files list', async () => {
      const res = await request(API_BASE)
        .get('/api/tf/var-files')
        .query({ path: TEST_ROOT })
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('files')
    })
  })

  describe('File API Endpoints', () => {
    it('GET /api/files should validate path parameter', async () => {
      const res = await request(API_BASE).get('/api/files')
      expect(res.status).toBe(400)
    })

    it('POST /api/files should validate required fields', async () => {
      const res = await request(API_BASE)
        .post('/api/files')
        .send({})
      expect(res.status).toBe(400)
    })

    it('GET /api/file-content should validate path parameter', async () => {
      const res = await request(API_BASE).get('/api/file-content')
      expect(res.status).toBe(400)
    })

    it('PUT /api/file-content should validate required fields', async () => {
      const res = await request(API_BASE)
        .put('/api/file-content')
        .send({})
      expect(res.status).toBe(400)
    })

    it('POST /api/rename should validate from and to parameters', async () => {
      const res = await request(API_BASE)
        .post('/api/rename')
        .send({})
      expect(res.status).toBe(400)
    })

    it('DELETE /api/files should validate path parameter', async () => {
      const res = await request(API_BASE).delete('/api/files')
      expect(res.status).toBe(400)
    })
  })

  describe('Search API Endpoints', () => {
    it('GET /api/search should validate q and path parameters', async () => {
      const res = await request(API_BASE).get('/api/search')
      expect(res.status).toBe(400)
    })

    it('POST /api/replace should validate required fields', async () => {
      const res = await request(API_BASE)
        .post('/api/replace')
        .send({})
      expect(res.status).toBe(400)
    })
  })

  describe('Git API Endpoints', () => {
    it('GET /api/git/status should validate path parameter', async () => {
      const res = await request(API_BASE).get('/api/git/status')
      expect(res.status).toBe(400)
    })

    it('GET /api/git/diff should validate path and file parameters', async () => {
      const res = await request(API_BASE).get('/api/git/diff').query({ path: '/tmp' })
      expect(res.status).toBe(400)
    })

    it('GET /api/git/log should validate path parameter', async () => {
      const res = await request(API_BASE).get('/api/git/log')
      expect(res.status).toBe(400)
    })

    it('POST /api/git/commit should validate required fields', async () => {
      const res = await request(API_BASE)
        .post('/api/git/commit')
        .send({})
      expect(res.status).toBe(400)
    })

    it('GET /api/git/branches should validate path parameter', async () => {
      const res = await request(API_BASE).get('/api/git/branches')
      expect(res.status).toBe(400)
    })

    it('POST /api/git/push should validate path parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/git/push')
        .send({})
      expect(res.status).toBe(400)
    })

    it('POST /api/git/pull should validate path parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/git/pull')
        .send({})
      expect(res.status).toBe(400)
    })
  })

  describe('Cloud API Endpoints', () => {
    it('GET /api/cloud/status should return status structure', async () => {
      const res = await request(API_BASE).get('/api/cloud/status')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('exists')
      expect(res.body).toHaveProperty('providers')
    })

    it('POST /api/cloud/credentials should validate action parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/cloud/credentials')
        .send({})
      expect(res.status).toBe(400)
    })

    it('POST /api/cloud/login should validate provider parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/cloud/login')
        .send({})
      expect(res.status).toBe(400)
    })

    it('POST /api/cloud/logout should validate provider parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/cloud/logout')
        .send({})
      expect(res.status).toBe(400)
    })
  })

  describe('Root Management Endpoints', () => {
    it('GET /api/roots should return roots structure', async () => {
      const res = await request(API_BASE).get('/api/roots')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('roots')
    })

    it('POST /api/roots should validate path parameter', async () => {
      const res = await request(API_BASE)
        .post('/api/roots')
        .send({})
      expect(res.status).toBe(400)
    })
  })
})
