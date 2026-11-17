// Gateway authentication service. Swap AUTH_MODE to plug in OAuth2 / OIDC / mTLS authenticators.
import { createAuthenticator } from '@axon-fleet/shared';

export function createAuthService({ mode, tokens }) {
  const authenticator = createAuthenticator({ mode, tokens });
  return {
    authenticate: (req) => authenticator.authenticate(req),
    describe: () => ({ mode, ...authenticator.describe(), credentialTransport: 'HTTP Authorization header (Bearer)', extensionPoints: ['oauth2', 'oidc', 'mtls'] }),
  };
}
