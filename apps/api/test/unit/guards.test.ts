import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../src/auth/auth.guard';
import { IS_PUBLIC, ROLE_REQUIREMENT, type RoleRequirement } from '../../src/auth/decorators';
import { InvalidTokenError, JwtVerifier } from '../../src/auth/jwt-verifier';
import { RolesGuard } from '../../src/auth/roles.guard';
import { ApiException } from '../../src/common/api-exception';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { JWT_SECRET, makeToken } from '../support/helpers';

function ctx(req: Record<string, unknown>, meta: Record<string, unknown> = {}): { context: ExecutionContext; reflector: Reflector } {
  const handler = () => undefined;
  const reflector = new Reflector();
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

const verifier = new JwtVerifier({ hs256Secret: JWT_SECRET, audience: 'authenticated' });

describe('JwtVerifier', () => {
  const sub = randomUUID();

  it('accepts a valid HS256 user token', async () => {
    const auth = await verifier.verify(await makeToken(sub, { aal: 'aal2' }));
    expect(auth).toMatchObject({ userId: sub, aal: 'aal2' });
  });

  it.each([
    ['expired', () => makeToken(sub, { expiresIn: Math.floor(Date.now() / 1000) - 3600 })],
    ['wrong secret', () => makeToken(sub, { secret: 'x'.repeat(40) })],
    ['wrong audience', () => makeToken(sub, { audience: 'other' })],
    ['service_role key', () => makeToken(sub, { role: 'service_role' })],
    ['anon key', () => makeToken(sub, { role: 'anon' })],
  ])('rejects %s', async (_name, mk) => {
    await expect(verifier.verify(await mk())).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects alg=none and garbage', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated', exp: 9e9 })).toString('base64url');
    await expect(verifier.verify(`${header}.${body}.`)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify('not.a.jwt')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify('')).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a non-uuid subject', async () => {
    const t = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    await expect(verifier.verify(t)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  describe('JWKS (asymmetric keys)', () => {
    let jwksVerifier: JwtVerifier;
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

    beforeAll(async () => {
      const kp = await generateKeyPair('ES256', { extractable: true });
      privateKey = kp.privateKey;
      const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
      jwksVerifier = new JwtVerifier({
        jwks: createLocalJWKSet({ keys: [jwk] }),
        audience: 'authenticated',
        issuer: 'https://proj.supabase.co/auth/v1',
      });
    });

    const es256 = (issuer = 'https://proj.supabase.co/auth/v1') =>
      new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setSubject(sub)
        .setAudience('authenticated')
        .setIssuer(issuer)
        .setExpirationTime('1h')
        .sign(privateKey);

    it('accepts ES256 tokens from the JWKS', async () => {
      await expect(jwksVerifier.verify(await es256())).resolves.toMatchObject({ userId: sub });
    });

    it('enforces the issuer', async () => {
      await expect(jwksVerifier.verify(await es256('https://evil.example/auth/v1'))).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects HS256 when no shared secret is configured (alg confusion)', async () => {
      await expect(jwksVerifier.verify(await makeToken(sub))).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects ES256 when only HS256 is configured', async () => {
      await expect(verifier.verify(await es256())).rejects.toBeInstanceOf(InvalidTokenError);
    });
  });
});

describe('AuthGuard', () => {
  it('lets @Public routes through without a token', async () => {
    const { context, reflector } = ctx({ headers: {} }, { [IS_PUBLIC]: true });
    await expect(new AuthGuard(reflector, verifier).canActivate(context)).resolves.toBe(true);
  });

  it('rejects missing / malformed Authorization headers with 401', async () => {
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }]) {
      const { context, reflector } = ctx({ headers });
      await expect(new AuthGuard(reflector, verifier).canActivate(context)).rejects.toMatchObject({ status: 401 });
    }
  });

  it('attaches the principal for a valid token', async () => {
    const sub = randomUUID();
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${await makeToken(sub)}` } };
    const { context, reflector } = ctx(req);
    await expect(new AuthGuard(reflector, verifier).canActivate(context)).resolves.toBe(true);
    expect(req.auth).toMatchObject({ userId: sub });
  });
});

describe('RolesGuard', () => {
  const repo = new InMemoryRepository();
  const admin = randomUUID();
  const editor = randomUUID();
  const viewer = randomUUID();
  const outsider = randomUUID();
  const org = repo.seedOrg({ name: 'Org A', slug: 'org-a' }, { [admin]: 'admin', [editor]: 'editor', [viewer]: 'viewer' });
  const auth = (userId: string, aal: 'aal1' | 'aal2' = 'aal1') => ({
    userId,
    aal,
    claims: { sub: userId, role: 'authenticated', exp: 9e9, aal },
  });

  const run = async (req: Record<string, unknown>, reqmt: RoleRequirement) => {
    const { context, reflector } = ctx(req, { [ROLE_REQUIREMENT]: reqmt });
    return new RolesGuard(reflector, repo).canActivate(context);
  };

  it('allows a sufficient role and records org access', async () => {
    const req: Record<string, unknown> = { auth: auth(editor), params: { orgId: org.id } };
    await expect(run(req, { minRole: 'editor', org: { from: 'param', key: 'orgId' } })).resolves.toBe(true);
    expect(req.orgAccess).toEqual({ orgId: org.id, role: 'editor' });
  });

  it('403 for a member with an insufficient role', async () => {
    const req = { auth: auth(viewer), params: { orgId: org.id } };
    await expect(run(req, { minRole: 'editor', org: { from: 'param', key: 'orgId' } })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('404 for non-members (no existence leak) and for invalid ids', async () => {
    await expect(
      run({ auth: auth(outsider), params: { orgId: org.id } }, { minRole: 'viewer', org: { from: 'param', key: 'orgId' } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      run({ auth: auth(admin), params: { orgId: 'nope' } }, { minRole: 'viewer', org: { from: 'param', key: 'orgId' } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('400 for an invalid org id in the body', async () => {
    await expect(
      run({ auth: auth(admin), body: { orgId: 42 } }, { minRole: 'editor', org: { from: 'body', key: 'orgId' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('resolves the org from a project id', async () => {
    const project = await repo.run(auth(editor), (tx) => tx.createProject({ orgId: org.id, name: 'P', address: null }));
    const req: Record<string, unknown> = { auth: auth(viewer), params: { projectId: project.id } };
    await expect(run(req, { minRole: 'viewer', org: { from: 'project-param', key: 'projectId' } })).resolves.toBe(true);
    expect(req.orgAccess).toEqual({ orgId: org.id, role: 'viewer' });
    await expect(
      run({ auth: auth(outsider), params: { projectId: project.id } }, { minRole: 'viewer', org: { from: 'project-param', key: 'projectId' } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('requires aal2 for MFA-gated admin actions', async () => {
    const reqmt: RoleRequirement = { minRole: 'admin', org: { from: 'param', key: 'orgId' }, requireMfa: true };
    const err = await run({ auth: auth(admin, 'aal1'), params: { orgId: org.id } }, reqmt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect(err).toMatchObject({ status: 403, code: 'mfa_required' });
    await expect(run({ auth: auth(admin, 'aal2'), params: { orgId: org.id } }, reqmt)).resolves.toBe(true);
  });

  it('is a no-op on routes without a requirement', async () => {
    const { context, reflector } = ctx({});
    await expect(new RolesGuard(reflector, repo).canActivate(context)).resolves.toBe(true);
  });
});
