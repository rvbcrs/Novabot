import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { userRepo, emailCodeRepo } from '../../db/repositories/index.js';
import { ok, fail } from '../../types/index.js';

export const validateRouter = Router();

// Generates a simple 6-digit code. In production, send this via email.
function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function expiresAt(minutes = 10): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// POST /api/nova-user/validate/sendAppRegistEmailCode
validateRouter.post('/sendAppRegistEmailCode', (req, res: Response) => {
  const { email } = req.body as { email?: string };
  if (!email) { res.json(fail('Email required', 400)); return; }

  const code = generateCode();
  emailCodeRepo.create(email, code, 'register', expiresAt());

  // TODO: send email with code
  console.log(`[VALIDATE] Register code sent to ${email}`);
  res.json(ok());
});

// POST /api/nova-user/validate/validAppRegistEmailCode
validateRouter.post('/validAppRegistEmailCode', (req, res: Response) => {
  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) { res.json(fail('Email and code required', 400)); return; }

  const row = emailCodeRepo.findValid(email, code, 'register');

  if (!row) { res.json(fail('Invalid or expired code', 400)); return; }

  emailCodeRepo.markUsedByEmailAndCode(email, code);
  res.json(ok());
});

// POST /api/nova-user/validate/sendAppResetPwdEmailCode
validateRouter.post('/sendAppResetPwdEmailCode', (req, res: Response) => {
  const { email } = req.body as { email?: string };
  if (!email) { res.json(fail('Email required', 400)); return; }

  const user = userRepo.findByEmail(email);
  if (!user) { res.json(fail('Email not found', 400)); return; }

  const code = generateCode();
  emailCodeRepo.create(email, code, 'reset_password', expiresAt());

  // TODO: send email with code
  console.log(`[VALIDATE] Reset password code sent to ${email}`);
  res.json(ok());
});

// POST /api/nova-user/validate/verifyAndResetAppPwd
validateRouter.post('/verifyAndResetAppPwd', (req, res: Response) => {
  const { email, code, newPassword } = req.body as {
    email?: string; code?: string; newPassword?: string;
  };
  if (!email || !code || !newPassword) {
    res.json(fail('email, code and newPassword required', 400));
    return;
  }

  const row = emailCodeRepo.findValid(email, code, 'reset_password');

  if (!row) { res.json(fail('Invalid or expired code', 400)); return; }

  const hashed = bcrypt.hashSync(newPassword, 10);
  userRepo.updatePasswordByEmail(email, hashed);
  emailCodeRepo.markUsedByEmailAndCode(email, code);
  res.json(ok());
});
