import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Marks a route as owner-only. Enforced by `JwtAuthGuard`, which is already on
 * every staff route — see the note there on why it is not a guard of its own.
 *
 * The default is that staff may do it. A desk person who cannot take a booking
 * is useless, and a permission model that gets in the way at the counter gets
 * worked around by sharing the owner's login, which is the problem this is
 * meant to solve.
 *
 * So the owner-only list is short, and it is about the *business* rather than
 * the day: money in aggregate, prices, what the public sees, and who else has
 * a login.
 */
export const OwnerOnly = () => SetMetadata(ROLES_KEY, ['owner']);
