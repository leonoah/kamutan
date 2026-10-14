import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { MeResponse, MyOrg, Org } from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, type Repository } from '../db/repository';

@Injectable()
export class OrgsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Optional() @Inject(BOQ_REPOSITORY) private readonly boq?: BoqRepository,
  ) {}

  private readonly logger = new Logger('OrgsService');

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
  async create(user: AuthContext, name: string): Promise<Org> {
    const org = await this.repo.createOrgWithAdmin(name, { uid: user.uid, email: user.email });
    // Sprint 3 bootstrap: default BOQ template (from the sample) + default rule set. Lazily re-seeded on first use.
    await this.boq?.seedDefaults(org.id).catch((err: unknown) => this.logger.warn({ err: (err as Error).message, orgId: org.id }, 'seedDefaults failed'));
    return org;
  }

  async get(user: AuthContext, orgId: string): Promise<MyOrg> {
    const { role } = await this.access.requireRole(user, orgId, 'viewer');
    const org = await this.repo.getOrg(orgId);
    if (!org) throw notFound('org');
    return { ...org, role };
  }
}
