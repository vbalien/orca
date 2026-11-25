// The desktop's local Slack service, beside its Orca Cloud connector but independent of sign-in.
import { join } from 'node:path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence/loading-store/store'
import { getSecretStore, hasSecretStore } from '../../shared/secure-storage/secret-store'
import { SlackLocalTokenStore } from './slack-local-token-store'
import { setSlackLocalService, SlackLocalService, slackLocalService } from './slack-local-service'

export function installSlackLocal(
  runtime: OrcaRuntimeService,
  store: Store,
  userDataPath: string
): void {
  const service = new SlackLocalService({
    runtime,
    store,
    tokens: new SlackLocalTokenStore(join(userDataPath, 'slack-local'), () =>
      hasSecretStore() ? getSecretStore() : null
    )
  })
  setSlackLocalService(service)
  service.start()
}

export function stopSlackLocal(): void {
  slackLocalService()?.stop()
  setSlackLocalService(null)
}
