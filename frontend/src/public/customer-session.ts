/**
 * A player's session on a venue's public page.
 *
 * sessionStorage, not localStorage: the token is short-lived and proves a phone
 * number, and these pages get opened on shared and borrowed phones. Closing the
 * tab should end it.
 *
 * Keyed by venue, because a token is scoped to one venue and carrying one
 * across pages would only produce confusing 401s.
 */
const key = (slug: string) => `bm.customer.${slug}`;

export function getSession(slug: string): string | null {
  try {
    return sessionStorage.getItem(key(slug));
  } catch {
    return null;
  }
}

export function setSession(slug: string, token: string | null) {
  try {
    if (token) sessionStorage.setItem(key(slug), token);
    else sessionStorage.removeItem(key(slug));
  } catch {
    /* storage blocked: the session simply lasts as long as the component does */
  }
}
