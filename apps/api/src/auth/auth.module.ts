import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuthGuard } from './auth.guard';
import { JwtVerifier } from './jwt-verifier';
import { RolesGuard } from './roles.guard';

@Global()
@Module({
  providers: [
    { provide: JwtVerifier, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => JwtVerifier.fromConfig(cfg) },
    AuthGuard,
    RolesGuard,
  ],
  exports: [JwtVerifier, AuthGuard, RolesGuard],
})
export class AuthModule {}
