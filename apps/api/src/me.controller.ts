import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from './auth/guards.js';
import type { AuthUser } from './http/request.js';

@ApiTags('Me')
@Controller('v1/me')
export class MeController {
  @Get()
  @ApiOperation({ summary: 'The signed-in user and the active organization on this session' })
  me(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      activeOrganizationId: req.authSession?.activeOrganizationId ?? null,
    };
  }
}
