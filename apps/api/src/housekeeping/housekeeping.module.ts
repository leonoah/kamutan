import { Module } from '@nestjs/common';
import { GovernanceModule } from '../governance/governance.module';
import { HousekeepingController } from './housekeeping.controller';
import { HousekeepingService } from './housekeeping.service';

/** Sprint 8: sheet-set / project deletes. */
@Module({
  imports: [GovernanceModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
