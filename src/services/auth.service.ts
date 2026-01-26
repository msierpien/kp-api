import bcrypt from 'bcrypt';
import prisma from '../lib/prisma';
import type { TokenResponse, JwtPayload } from '../types';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

export class AuthService {
  private jwt: {
    sign: (payload: object, options?: { expiresIn: string }) => string;
    verify: <T>(token: string) => T;
  };

  constructor(jwt: typeof AuthService.prototype.jwt) {
    this.jwt = jwt;
  }

  async login(email: string, password: string): Promise<TokenResponse> {
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new Error('Nieprawidłowy email lub hasło');
    }

    if (!user.isActive) {
      throw new Error('Konto jest nieaktywne');
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new Error('Nieprawidłowy email lub hasło');
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      role: user.role as 'ADMIN' | 'SELLER',
    };

    const accessToken = this.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = this.jwt.sign(
      { ...payload, type: 'refresh' },
      { expiresIn: REFRESH_TOKEN_EXPIRY }
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    try {
      const decoded = this.jwt.verify<JwtPayload & { type?: string }>(refreshToken);

      if (decoded.type !== 'refresh') {
        throw new Error('Nieprawidłowy token');
      }

      // Verify user still exists and is active
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });

      if (!user || !user.isActive) {
        throw new Error('Użytkownik nie istnieje lub jest nieaktywny');
      }

      const payload: JwtPayload = {
        userId: user.id,
        email: user.email,
        role: user.role as 'ADMIN' | 'SELLER',
      };

      const accessToken = this.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRY });

      return { accessToken };
    } catch (error) {
      throw new Error('Nieprawidłowy lub wygasły token');
    }
  }

  verifyToken(token: string): JwtPayload {
    try {
      return this.jwt.verify<JwtPayload>(token);
    } catch {
      throw new Error('Nieprawidłowy lub wygasły token');
    }
  }
}
