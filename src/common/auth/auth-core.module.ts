import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrincipalResolver } from './principal.resolver.js';

/** JWT + principal resolution, shared by the global AuthGuard and the admin module. */
@Global()
@Module({
  // Secret/issuer/audience are passed explicitly on every sign/verify (no implicit defaults).
  imports: [JwtModule.register({})],
  providers: [PrincipalResolver],
  exports: [PrincipalResolver, JwtModule],
})
export class AuthCoreModule {}
