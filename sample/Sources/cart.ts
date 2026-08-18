// Here to exercise xcodeI18n.sourceFilePatterns: add "*.ts" to the setting and
// re-run "Find unused keys" — these keys stop being reported as unused.
export const CART_BADGE = t('%lld items in cart');
export const SIGN_OUT = t(`settings.signOut`);

function t(key: string): string {
  return key;
}
