import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import type { TokenResponse, JwtPayload, UserRole } from '../types';
import { normalizeFeatures } from '../lib/features';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AuthRequestMeta = {
  userAgent?: string;
  ipAddress?: string;
};

type RefreshJwtPayload = JwtPayload & {
  type?: string;
  sessionId?: string;
};

function hashRefreshToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTokenExpiresAt() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
}

export class AuthService {
  private jwt: {
    sign: (payload: object, options?: { expiresIn: string }) => string;
    verify: <T>(token: string) => T;
  };

  constructor(jwt: typeof AuthService.prototype.jwt) {
    this.jwt = jwt;
  }

  async login(email: string, password: string, meta: AuthRequestMeta = {}): Promise<TokenResponse> {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            featuresJson: true,
          },
        },
      },
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
      role: user.role as UserRole,
      tenantId: user.tenantId,
    };

    const accessToken = this.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const sessionId = crypto.randomUUID();
    const refreshToken = this.jwt.sign(
      { ...payload, type: 'refresh', sessionId },
      { expiresIn: REFRESH_TOKEN_EXPIRY }
    );

    await prisma.authSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        tenantId: user.tenantId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
        expiresAt: refreshTokenExpiresAt(),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as UserRole,
        tenantId: user.tenantId,
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name,
          slug: user.tenant.slug,
          features: normalizeFeatures(user.tenant.featuresJson),
        },
      },
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const decoded = this.jwt.verify<RefreshJwtPayload>(refreshToken);

      if (decoded.type !== 'refresh' || !decoded.sessionId) {
        throw new Error('Nieprawidłowy token');
      }

      const session = await prisma.authSession.findUnique({
        where: { id: decoded.sessionId },
        include: { user: true },
      });

      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.refreshTokenHash !== hashRefreshToken(refreshToken)
      ) {
        throw new Error('Nieprawidłowy token');
      }

      const user = session.user;
      if (!user.isActive) {
        throw new Error('Użytkownik nie istnieje lub jest nieaktywny');
      }

      const payload: JwtPayload = {
        userId: user.id,
        email: user.email,
        role: user.role as UserRole,
        tenantId: user.tenantId,
      };

      const accessToken = this.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRY });
      const nextRefreshToken = this.jwt.sign(
        { ...payload, type: 'refresh', sessionId: session.id },
        { expiresIn: REFRESH_TOKEN_EXPIRY }
      );

      const rotation = await prisma.authSession.updateMany({
        where: {
          id: session.id,
          refreshTokenHash: hashRefreshToken(refreshToken),
          revokedAt: null,
        },
        data: {
          refreshTokenHash: hashRefreshToken(nextRefreshToken),
          expiresAt: refreshTokenExpiresAt(),
        },
      });

      if (rotation.count !== 1) {
        throw new Error('Nieprawidłowy token');
      }

      return { accessToken, refreshToken: nextRefreshToken };
    } catch (error) {
      throw new Error('Nieprawidłowy lub wygasły token');
    }
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;

    try {
      const decoded = this.jwt.verify<RefreshJwtPayload>(refreshToken);
      if (decoded.type !== 'refresh' || !decoded.sessionId) return;

      await prisma.authSession.updateMany({
        where: { id: decoded.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Logout should be idempotent even when the cookie is already invalid.
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
