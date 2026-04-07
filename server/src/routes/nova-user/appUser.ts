import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware, signToken } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, UserRow } from '../../types/index.js';
import { callLfiCloud, encryptCloudPassword } from '../setup.js';

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
appUserRouter.post('/login', async (req, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.json(fail('Email and password required', 400));
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as UserRow | undefined;
  if (!user) {
    // User not found locally — try cloud login + auto-import
    try {
      {
        const plainPw = tryDecryptAppPassword(password);
        const encPw = encryptCloudPassword(plainPw);
        const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
          email, password: encPw, imei: 'imei',
        }) as Record<string, unknown>;
        const loginVal = loginResp?.value as Record<string, unknown> | undefined;

        if (loginResp?.success && loginVal?.accessToken) {
          // Cloud login OK — create local user
          const hash = bcrypt.hashSync(plainPw, 10);
          const appUserId = crypto.randomUUID();
          const isFirst = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c === 0;
          db.prepare(
            'INSERT INTO users (app_user_id, email, password, username, is_admin, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
          ).run(appUserId, normalizedEmail, hash, normalizedEmail.split('@')[0], isFirst ? 1 : 0);
          console.log('[Login] Auto-imported user from cloud: ' + email + ' (admin=' + isFirst + ')');

          // Fetch and import devices
          const equipResp = await callLfiCloud('POST', '/api/nova-user/equipment/userEquipmentList', {
            appUserId: loginVal.appUserId, pageSize: 10, pageNo: 1,
          }, loginVal.accessToken as string) as Record<string, unknown>;
          const pageList = ((equipResp?.value as Record<string, unknown>)?.pageList ?? []) as Record<string, unknown>[];

          for (const equip of pageList) {
            const mowerSn = equip.mowerSn as string | undefined;
            const chargerSn = equip.chargerSn as string | undefined;
            const primarySn = mowerSn ?? chargerSn;
            if (!primarySn) continue;
            const existing = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ?').get(primarySn);
            if (!existing) {
              db.prepare(
                'INSERT INTO equipment (equipment_id, user_id, mower_sn, charger_sn, equipment_nick_name, charger_address, charger_channel, mac_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
              ).run(
                crypto.randomUUID(), appUserId, primarySn, chargerSn ?? null,
                (equip.userCustomDeviceName ?? equip.equipmentNickName ?? null) as string | null,
                (equip.chargerAddress ?? null) as number | null,
                (equip.chargerChannel ?? null) as number | null,
                (equip.macAddress ?? null) as string | null,
              );
            }
          }
          console.log('[Login] Imported ' + pageList.length + ' device(s) for ' + email);

          // Re-fetch the newly created user
          user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as UserRow | undefined;
        }
      }
    } catch (cloudErr) {
      console.log('[Login] Cloud fallback failed:', cloudErr instanceof Error ? cloudErr.message : cloudErr);
    }

    if (!user) {
      res.json(fail('Invalid email or password', 400));
      return;
    }
  }

  // De app stuurt AES-versleutelde wachtwoorden (key/IV = "1234123412ABCDEF").
  // Decrypt eerst, dan vergelijken. Fallback naar raw voor niet-versleutelde waarden.
  const plainPassword = tryDecryptAppPassword(password);

  const isBcrypt = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
  let match = false;
  if (isBcrypt) {
    match = bcrypt.compareSync(plainPassword, user.password);
  } else {
    // Cloud-imported passwords are stored as AES-encrypted values.
    // Compare: direct match, decrypted app password match, or decrypt stored and compare with plain.
    match = user.password === password || user.password === plainPassword;
    if (!match) {
      // Try decrypting the stored password and compare with plain input
      try {
        const key = Buffer.from('1234123412ABCDEF', 'utf8');
        const iv = Buffer.from('1234123412ABCDEF', 'utf8');
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        let decrypted = decipher.update(user.password, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        match = decrypted === plainPassword;
      } catch { /* not AES encrypted — skip */ }
    }
  }

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

  const regEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(regEmail);
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
  `).run(appUserId, regEmail, storedPassword, username ?? null);

  const newUser = db.prepare('SELECT id FROM users WHERE app_user_id = ?').get(appUserId) as { id: number };
  const token = signToken({ userId: appUserId, email: regEmail });
  res.json(ok({ appUserId: newUser.id, email: regEmail, token }));
});

// POST /api/nova-user/appUser/loginOut
appUserRouter.post('/loginOut', authMiddleware, (_req, res: Response) => {
  // JWT is stateless; client discards the token on its side.
  // If you want server-side invalidation, add a token blacklist table.
  res.json(ok());
});

// GET /api/nova-user/appUser/appUserInfo?email=
// IDOR bescherming: negeer de email query param — gebruik altijd het email uit de JWT token.
// De cloud laat toe dat elke user andermans info ophaalt (IDOR bug), wij niet.
appUserRouter.get('/appUserInfo', authMiddleware, (req: AuthRequest, res: Response) => {
  const email = req.email;
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
