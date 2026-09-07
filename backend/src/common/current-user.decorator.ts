import { ExecutionContext, createParamDecorator } from '@nestjs/common';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'owner' | 'staff';
}

/**
 * Every request carries the tenant it belongs to. Services take tenantId as an
 * explicit argument so that a missing scope is a compile error rather than a
 * silent cross-tenant read.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});
