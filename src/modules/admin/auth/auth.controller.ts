import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { Principal } from '../../../common/auth/principal.js';
import { AuthThrottle } from '../../../common/auth/throttle.decorators.js';
import {
  AdminOnly,
  Authenticated,
  CurrentPrincipal,
  Public,
} from '../../../common/decorators/auth.decorators.js';
import { AuthService } from './auth.service.js';
import {
  ChangePasswordDto,
  LoginDto,
  MeDto,
  RefreshDto,
  TokenPairDto,
} from './dto/auth.dto.js';

const meta = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

@ApiTags('admin · auth')
@Controller('admin/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with e-mail and password',
    description:
      'Returns a short-lived access token and a single-use refresh token. Accounts lock after repeated failures.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse({
    description:
      'Invalid e-mail or password (also for locked or disabled accounts)',
  })
  @ApiTooManyRequestsResponse()
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokenPairDto> {
    return this.auth.login(dto.email, dto.password, meta(req));
  }

  @Post('refresh')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens rotate: each works once. Replaying a used token revokes the whole session.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokenPairDto> {
    return this.auth.refresh(dto.refreshToken, meta(req));
  }

  @Post('logout')
  @Authenticated()
  @AdminOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End this session (or every session with ?everywhere=true)',
  })
  @ApiQuery({ name: 'everywhere', required: false, type: Boolean })
  @ApiNoContentResponse()
  logout(
    @CurrentPrincipal() p: Principal,
    @Query('everywhere') everywhere?: string,
  ): Promise<void> {
    return this.auth.logout(p, everywhere === 'true');
  }

  @Get('me')
  @Authenticated()
  @AdminOnly()
  @ApiOperation({
    summary: 'The signed-in admin, their roles and effective permissions',
  })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentPrincipal() p: Principal): Promise<MeDto> {
    return this.auth.me(p);
  }

  @Post('change-password')
  @Authenticated()
  @AdminOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change your password (ends all your sessions)' })
  @ApiNoContentResponse()
  changePassword(
    @CurrentPrincipal() p: Principal,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.auth.changePassword(p, dto.currentPassword, dto.newPassword);
  }
}
