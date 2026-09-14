import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRemoteSupportRouter } from '../../routes/remoteSupport.js';
import { Relay } from '../../services/remoteSupport/relay.js';

const TEST_SECRET = 'unit-test-secret';

describe('GET /api/remote-support/active-agents', () => {
  let app: express.Express;
  // Eén luisteraar per test. `request(server)` opent er per VERZOEK een, en onder
  // belasting botst dat met een andere luisteraar: het antwoord komt dan ergens
  // anders vandaan. De andere twintig bestanden delen er één per bestand; hier
  // wordt de app per test gebouwd, dus hoort hij per test.
  let server: import('http').Server;
  let relay: Relay;

  beforeEach(() => {
    relay = new Relay();
    app = express();
    app.use('/api/remote-support', createRemoteSupportRouter({
      relay,

      auditLogDir: '/tmp',
      isOperator: () => true,
    }));
    server = app.listen(0);
  });

  afterEach(() => new Promise<void>(r => { server.close(() => r()); }));

  it('returns empty list initially', async () => {
    const res = await request(server).get('/api/remote-support/active-agents');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it('returns SN once an agent registers', async () => {
    const router = createRemoteSupportRouter({
      relay,

      auditLogDir: '/tmp',
      isOperator: () => true,
    });
    (router as any)._registerAgent('LFIN2231000656');
    const localApp = express();
    localApp.use('/api/remote-support', router);
    const res = await request(localApp).get('/api/remote-support/active-agents');
    expect(res.body.agents).toContainEqual(expect.objectContaining({ sn: 'LFIN2231000656' }));
  });

  it('rejects non-operator callers', async () => {
    // Eigen app met isOperator: false, dus ook een eigen luisteraar. De
    // beforeEach-server draait de operator-variant en zou 200 antwoorden.
    const denyApp = express();
    denyApp.use('/api/remote-support', createRemoteSupportRouter({
      relay,

      auditLogDir: '/tmp',
      isOperator: () => false,
    }));
    const denyServer = denyApp.listen(0);
    try {
      const res = await request(denyServer).get('/api/remote-support/active-agents');
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>(r => { denyServer.close(() => r()); });
    }
  });
});

describe('POST /api/remote-support/toggle', () => {
  let app: express.Express;
  // Eén luisteraar per test. `request(server)` opent er per VERZOEK een, en onder
  // belasting botst dat met een andere luisteraar: het antwoord komt dan ergens
  // anders vandaan. De andere twintig bestanden delen er één per bestand; hier
  // wordt de app per test gebouwd, dus hoort hij per test.
  let server: import('http').Server;
  let relay: Relay;
  beforeEach(() => {
    relay = new Relay();
    app = express();
    app.use(express.json());
    app.use('/api/remote-support', createRemoteSupportRouter({
      relay, auditLogDir: '/tmp', isOperator: () => false,
      enabledFlagPath: '/tmp/test-remote-support-flag',
    }));
    server = app.listen(0);
  });

  afterEach(() => new Promise<void>(r => { server.close(() => r()); }));

  it('enables the agent flag', async () => {
    const res = await request(server)
      .post('/api/remote-support/toggle')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('disables the agent flag', async () => {
    await request(server).post('/api/remote-support/toggle').send({ enabled: true });
    const res = await request(server).post('/api/remote-support/toggle').send({ enabled: false });
    expect(res.body.enabled).toBe(false);
  });
});

describe('POST /api/remote-support/kill', () => {
  let app: express.Express;
  // Eén luisteraar per test. `request(server)` opent er per VERZOEK een, en onder
  // belasting botst dat met een andere luisteraar: het antwoord komt dan ergens
  // anders vandaan. De andere twintig bestanden delen er één per bestand; hier
  // wordt de app per test gebouwd, dus hoort hij per test.
  let server: import('http').Server;
  let relay: Relay;
  beforeEach(() => {
    relay = new Relay();
    relay.registerAgent('LFIN2231000656');
    app = express();
    app.use(express.json());
    app.use('/api/remote-support', createRemoteSupportRouter({
      relay, auditLogDir: '/tmp', isOperator: () => false,
    }));
    server = app.listen(0);
  });

  afterEach(() => new Promise<void>(r => { server.close(() => r()); }));

  it('closes the session for the calling SN', async () => {
    relay.requestSession('LFIN2231000656');
    const res = await request(server)
      .post('/api/remote-support/kill')
      .send({ sn: 'LFIN2231000656' });
    expect(res.status).toBe(200);
    expect(relay.getState('LFIN2231000656')).toBe('CLOSED');
  });
});

describe('agent-mode router', () => {
  // The agent mode is what user containers mount. The four bugs that
  // shipped before this commit set were rooted in the fact that this code
  // path was never wired up — these tests pin it open so a regression
  // shows up immediately.
  let app: express.Express;
  // Eén luisteraar per test. `request(server)` opent er per VERZOEK een, en onder
  // belasting botst dat met een andere luisteraar: het antwoord komt dan ergens
  // anders vandaan. De andere twintig bestanden delen er één per bestand; hier
  // wordt de app per test gebouwd, dus hoort hij per test.
  let server: import('http').Server;
  let pending: { requestId: string; since: number } | null = null;
  let approved: string[] = [];
  let denied: string[] = [];
  let killed = 0;

  beforeEach(() => {
    pending = { requestId: 'req-1', since: 1700000000000 };
    approved = [];
    denied = [];
    killed = 0;
    app = express();
    app.use(express.json());
    app.use('/api/remote-support', createRemoteSupportRouter({
      mode: 'agent',
      auditLogDir: '/tmp',
      enabledFlagPath: '/tmp/test-rs-agent-flag',
      getPendingRequest: () => pending,
      approveRequest: (id) => { approved.push(id); pending = null; },
      denyRequest: (id) => { denied.push(id); pending = null; },
      killSession: () => { killed += 1; },
    }));
    server = app.listen(0);
  });

  afterEach(() => new Promise<void>(r => { server.close(() => r()); }));

  it('returns pendingRequest in /status', async () => {
    const res = await request(server).get('/api/remote-support/status');
    expect(res.status).toBe(200);
    expect(res.body.pendingRequest).toEqual({ requestId: 'req-1', since: 1700000000000 });
  });

  it('returns null pendingRequest when nothing is pending', async () => {
    pending = null;
    const res = await request(server).get('/api/remote-support/status');
    expect(res.body.pendingRequest).toBeNull();
  });

  it('POST /approve drives approveRequest with the requestId', async () => {
    const res = await request(server)
      .post('/api/remote-support/approve')
      .send({ requestId: 'req-1' });
    expect(res.status).toBe(200);
    expect(approved).toEqual(['req-1']);
  });

  it('POST /approve rejects missing requestId', async () => {
    const res = await request(server)
      .post('/api/remote-support/approve')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /deny drives denyRequest with the requestId', async () => {
    const res = await request(server)
      .post('/api/remote-support/deny')
      .send({ requestId: 'req-1' });
    expect(res.status).toBe(200);
    expect(denied).toEqual(['req-1']);
  });

  it('POST /kill calls killSession (no SN needed)', async () => {
    const res = await request(server)
      .post('/api/remote-support/kill')
      .send({});
    expect(res.status).toBe(200);
    expect(killed).toBe(1);
  });
});
