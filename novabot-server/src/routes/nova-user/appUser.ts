import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware, signToken } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, UserRow } from '../../types/index.js';

// De Novabot app versleutelt wachtwoorden met AES-128-CBC voor verzending.
// key = IV = "1234123412ABCDEF" (16 bytes), output = base64
// Bron: research/NOVABOT_API_REFERENCE.md
const APP_PASSWORD_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

function tryDecryptAppPassword(raw: string): string {
  try {
    const enc = Buffer.from(raw, 'base64');
    if (enc.length < 16 || enc.length % 16 !== 0) return raw;
    // App gebruikt PKCS7 padding (standaard AES) — auto-padding aan laten staan
    const d = crypto.createDecipheriv('aes-128-cbc', APP_PASSWORD_KEY_IV, APP_PASSWORD_KEY_IV);
    const dec = Buffer.concat([d.update(enc), d.final()]);
    if (dec.length === 0) return raw;
    return dec.toString('utf8');
  } catch {
    return raw;
  }
}

export const appUserRouter = Router();

// POST /api/nova-user/appUser/login
appUserRouter.post('/login', (req, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.json(fail('Email and password required', 400));
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  if (!user) {
    res.json(fail('Invalid email or password', 400));
    return;
  }

  // De app stuurt AES-versleutelde wachtwoorden (key/IV = "1234123412ABCDEF").
  // Decrypt eerst, dan vergelijken. Fallback naar raw voor niet-versleutelde waarden.
  const plainPassword = tryDecryptAppPassword(password);

  const isBcrypt = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
  const match = isBcrypt
    ? bcrypt.compareSync(plainPassword, user.password)
    : user.password === password || user.password === plainPassword;

  if (!match) {
    res.json(fail('Invalid email or password', 400));
    return;
  }

  const token = signToken({ userId: user.app_user_id, email: user.email });
  // Exact format van de echte Novabot API response
  // appUserId = integer (Dart typed als int — UUID geeft CastError)
  // MQTT clientId van de app komt uit de JWT userId (UUID), niet uit appUserId
  res.json(ok({
    appUserId: user.id,
    email: user.email,
    phone: '',
    firstName: user.username ?? '',
    lastName: '',
    accessToken: token,
    newUserFlag: 0,
    country: '',
    city: '',
    address: '',
    coordinates: '',
  }));
});

// POST /api/nova-user/appUser/regist
appUserRouter.post('/regist', async (req, res: Response) => {
  const { email, password, username } = req.body as {
    email?: string; password?: string; username?: string;
  };
  if (!email || !password) {
    res.json(fail('Email and password required', 400));
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    res.json(fail('Email already registered', 400));
    return;
  }

  // Decrypt het AES-wachtwoord van de app, sla op als bcrypt hash.
  const plainPassword = tryDecryptAppPassword(password);
  const storedPassword = await bcrypt.hash(plainPassword, 10);
  const appUserId = uuidv4();
  db.prepare(`
    INSERT INTO users (app_user_id, email, password, username)
    VALUES (?, ?, ?, ?)
  `).run(appUserId, email, storedPassword, username ?? null);

  const newUser = db.prepare('SELECT id FROM users WHERE app_user_id = ?').get(appUserId) as { id: number };
  const token = signToken({ userId: appUserId, email });
  res.json(ok({ appUserId: newUser.id, email, token }));
});

// POST /api/nova-user/appUser/loginOut
appUserRouter.post('/loginOut', authMiddleware, (_req, res: Response) => {
  // JWT is stateless; client discards the token on its side.
  // If you want server-side invalidation, add a token blacklist table.
  res.json(ok());
});

// GET /api/nova-user/appUser/appUserInfo?email=
appUserRouter.get('/appUserInfo', authMiddleware, (req: AuthRequest, res: Response) => {
  const email = req.query.email as string | undefined ?? req.email;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  if (!user) {
    res.json(fail('User not found', 404));
    return;
  }
  res.json(ok({
    appUserId: user.id,
    email: user.email,
    username: user.username,
    machineToken: user.machine_token,
  }));
});

// POST /api/nova-user/appUser/appUserInfoUpdate
appUserRouter.post('/appUserInfoUpdate', authMiddleware, (req: AuthRequest, res: Response) => {
  const { username } = req.body as { username?: string };
  db.prepare('UPDATE users SET username = ? WHERE app_user_id = ?')
    .run(username ?? null, req.userId);
  res.json(ok());
});

// POST /api/nova-user/appUser/appUserPwdUpdate
appUserRouter.post('/appUserPwdUpdate', authMiddleware, (req: AuthRequest, res: Response) => {
  const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
  if (!oldPassword || !newPassword) {
    res.json(fail('oldPassword and newPassword required', 400));
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE app_user_id = ?').get(req.userId) as UserRow | undefined;
  if (!user || !bcrypt.compareSync(oldPassword, user.password)) {
    res.json(fail('Old password incorrect', 400));
    return;
  }

  const hashed = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE app_user_id = ?').run(hashed, req.userId);
  res.json(ok());
});

// POST /api/nova-user/appUser/deleteAccount
appUserRouter.post('/deleteAccount', authMiddleware, (req: AuthRequest, res: Response) => {
  db.prepare('DELETE FROM users WHERE app_user_id = ?').run(req.userId);
  res.json(ok());
});

// POST /api/nova-user/appUser/updateAppUserMachineToken
appUserRouter.post('/updateAppUserMachineToken', authMiddleware, (req: AuthRequest, res: Response) => {
  const { machineToken } = req.body as { machineToken?: string };
  db.prepare('UPDATE users SET machine_token = ? WHERE app_user_id = ?')
    .run(machineToken ?? null, req.userId);
  res.json(ok());
});
