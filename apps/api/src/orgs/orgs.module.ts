import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({ imports: [MembersModule], controllers: [OrgsController], providers: [OrgsService], exports: [OrgsService] })
export class OrgsModule {}
