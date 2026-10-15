import { Global, Module } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { AuthGuard } from './auth.guard';
import { FirebaseIdTokenVerifier, ID_TOKEN_VERIFIER } from './id-token-verifier';
import { RolesGuard } from './roles.guard';

@Global()
@Module({
  providers: [
    {
      provide: ID_TOKEN_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new FirebaseIdTokenVerifier(firebaseApp(cfg)),
    },
    AccessService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [ID_TOKEN_VERIFIER, AccessService, AuthGuard, RolesGuard],
})
export class AuthModule {}
