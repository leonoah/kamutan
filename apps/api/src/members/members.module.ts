import { Module } from '@nestjs/common';
import { InvitesController, OrgMembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({ controllers: [OrgMembersController, InvitesController], providers: [MembersService], exports: [MembersService] })
export class MembersModule {}
