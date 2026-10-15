import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { App } from 'firebase-admin/app';
import { describe, expect, it, vi } from 'vitest';
import { AccessService } from '../../src/access/access.service';
import { AuthGuard } from '../../src/auth/auth.guard';
import { IS_PUBLIC, ROLE_REQUIREMENT, type RoleRequirement } from '../../src/auth/decorators';
import { FirebaseIdTokenVerifier, InvalidTokenError, principalFromClaims } from '../../src/auth/id-token-verifier';
import { RolesGuard } from '../../src/auth/roles.guard';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { FakeIdTokenVerifier, user } from '../support/fake-verifier';

const verifyIdToken = vi.fn();
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken }) }));

function ctx(req: Record<string, unknown>, meta: Record<string, unknown> = {}): { context: ExecutionContext; reflector: Reflector } {
  const handler = () => undefined;
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  return { context, reflector: new Reflector() };
}

const JWT_LIKE = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';

describe('FirebaseIdTokenVerifier', () => {
  const v = new FirebaseIdTokenVerifier({} as App);

  it('verifies with checkRevoked=true and maps claims (MFA from sign_in_second_factor)', async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: 'u1', email: 'a@b.c', firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' } });
    await expect(v.verify(JWT_LIKE)).resolves.toMatchObject({ uid: 'u1', mfa: true, email: 'a@b.c' });
    expect(verifyIdToken).toHaveBeenCalledWith(JWT_LIKE, true);

    verifyIdToken.mockResolvedValueOnce({ uid: 'u2', firebase: { sign_in_provider: 'google.com' } });
    await expect(v.verify(JWT_LIKE)).resolves.toMatchObject({ uid: 'u2', mfa: false });
  });

  it.each([['auth/id-token-revoked'], ['auth/id-token-expired'], ['auth/argument-error'], ['auth/user-disabled']])(
    'maps firebase-admin error %s to InvalidTokenError',
    async (code) => {
      verifyIdToken.mockRejectedValueOnce(Object.assign(new Error('x'), { code }));
      await expect(v.verify(JWT_LIKE)).rejects.toMatchObject({ reason: code.replace('auth/', '') });
    },
  );

  it('rejects malformed tokens without calling Firebase', async () => {
    verifyIdToken.mockClear();
    for (const t of ['', 'abc', 'a.b', 'x'.repeat(9000)]) await expect(v.verify(t)).rejects.toBeInstanceOf(InvalidTokenError);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects anonymous sessions and unexpected claim shapes', () => {
    expect(() => principalFromClaims({ uid: 'u', firebase: { sign_in_provider: 'anonymous' } })).toThrow(InvalidTokenError);
    expect(() => principalFromClaims({ sub: 'u' })).toThrow(InvalidTokenError);
  });
});

describe('AuthGuard', () => {
  const fake = new FakeIdTokenVerifier();

  it('lets @Public routes through without a token', async () => {
    const { context, reflector } = ctx({ headers: {} }, { [IS_PUBLIC]: true });
    await expect(new AuthGuard(reflector, fake).canActivate(context)).resolves.toBe(true);
  });

  it('401 for missing / malformed / revoked tokens', async () => {
    const t = fake.issue('u1');
    fake.revoke(t);
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }, { authorization: `Bearer ${t}` }]) {
      const { context, reflector } = ctx({ headers });
      await expect(new AuthGuard(reflector, fake).canActivate(context)).rejects.toMatchObject({ status: 401 });
    }
  });

  it('attaches the principal for a valid token', async () => {
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${fake.issue('u9', { mfa: true })}` } };
    const { context, reflector } = ctx(req);
    await expect(new AuthGuard(reflector, fake).canActivate(context)).resolves.toBe(true);
    expect(req.auth).toMatchObject({ uid: 'u9', mfa: true });
  });
});

describe('RolesGuard (membership from orgs/{orgId}/members/{uid})', () => {
  const repo = new InMemoryRepository();
  const access = new AccessService(repo);
  const org = repo.seedOrg('Org A', { admin: 'admin', editor: 'editor', viewer: 'viewer' });
  repo.seedOrg('Org B', { outsider: 'admin' });

  const run = async (req: Record<string, unknown>, reqmt: RoleRequirement) => {
    const { context, reflector } = ctx(req, { [ROLE_REQUIREMENT]: reqmt });
    return new RolesGuard(reflector, access).canActivate(context);
  };
  const byParam: RoleRequirement['org'] = { from: 'param', key: 'orgId' };

  it('allows a sufficient role and records org access', async () => {
    const req: Record<string, unknown> = { auth: user('editor'), params: { orgId: org.id } };
    await expect(run(req, { minRole: 'editor', org: byParam })).resolves.toBe(true);
    expect(req.orgAccess).toEqual({ orgId: org.id, role: 'editor' });
  });

  it('403 for a member with an insufficient role', async () => {
    await expect(run({ auth: user('viewer'), params: { orgId: org.id } }, { minRole: 'editor', org: byParam })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('404 for non-members and invalid ids (no existence leak)', async () => {
    await expect(run({ auth: user('outsider'), params: { orgId: org.id } }, { minRole: 'viewer', org: byParam })).rejects.toMatchObject({ status: 404 });
    await expect(run({ auth: user('admin'), params: { orgId: '../x' } }, { minRole: 'viewer', org: byParam })).rejects.toMatchObject({ status: 404 });
  });

  it('400 when a body/query org id is missing', async () => {
    await expect(run({ auth: user('admin'), body: {} }, { minRole: 'editor', org: { from: 'body', key: 'orgId' } })).rejects.toMatchObject({ status: 400 });
  });

  it('resolves the org from a project id', async () => {
    const p = await repo.createProject(org.id, { name: 'P' }, 'editor');
    const req: Record<string, unknown> = { auth: user('viewer'), params: { projectId: p.id } };
    await expect(run(req, { minRole: 'viewer', org: { from: 'project-param', key: 'projectId' } })).resolves.toBe(true);
    expect(req.orgAccess).toEqual({ orgId: org.id, role: 'viewer' });
    await expect(
      run({ auth: user('outsider'), params: { projectId: p.id } }, { minRole: 'viewer', org: { from: 'project-param', key: 'projectId' } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('requires an MFA session for MFA-gated admin actions', async () => {
    const reqmt: RoleRequirement = { minRole: 'admin', org: byParam, requireMfa: true };
    await expect(run({ auth: user('admin'), params: { orgId: org.id } }, reqmt)).rejects.toMatchObject({ status: 403, code: 'mfa_required' });
    await expect(run({ auth: user('admin', { mfa: true }), params: { orgId: org.id } }, reqmt)).resolves.toBe(true);
  });

  it('a role change takes effect on the next request (DB is authoritative, not claims)', async () => {
    repo.setMember(org.id, 'promoted', 'viewer');
    await expect(run({ auth: user('promoted'), params: { orgId: org.id } }, { minRole: 'editor', org: byParam })).rejects.toMatchObject({ status: 403 });
    repo.setMember(org.id, 'promoted', 'editor');
    await expect(run({ auth: user('promoted'), params: { orgId: org.id } }, { minRole: 'editor', org: byParam })).resolves.toBe(true);
  });
});
