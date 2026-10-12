import { Inject, Injectable } from '@nestjs/common';
import type { MeResponse, MyOrg, Org } from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';

@Injectable()
export class OrgsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
  ) {}

  async myOrgs(user: AuthContext): Promise<MyOrg[]> {
    const memberships = await this.repo.listMembershipsOf(user.uid);
    const orgs = await Promise.all(
      memberships.map(async (m) => {
        const org = await this.repo.getOrg(m.orgId);
        return org ? { ...org, role: m.role } : null;
      }),
    );
    return orgs.filter((o): o is MyOrg => o !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async me(user: AuthContext): Promise<MeResponse> {
    return { uid: user.uid, mfa: user.mfa, orgs: await this.myOrgs(user) };
  }

  /** Any signed-in user may create an org and becomes its admin. */
  create(user: AuthContext, name: string): Promise<Org> {
    return this.repo.createOrgWithAdmin(name, { uid: user.uid, email: user.email });
  }

  async get(user: AuthContext, orgId: string): Promise<MyOrg> {
    const { role } = await this.access.requireRole(user, orgId, 'viewer');
    const org = await this.repo.getOrg(orgId);
    if (!org) throw notFound('org');
    return { ...org, role };
  }
}
