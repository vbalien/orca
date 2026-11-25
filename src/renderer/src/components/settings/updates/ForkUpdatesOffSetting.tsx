// A vbalien/orca fork build: self-update is off, so Settings shows the version and where new builds come from
// instead of the check button, automatic updates, delay and channel switching.
import type React from 'react'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'

export const FORK_RELEASES_URL = 'https://github.com/vbalien/orca/releases'

export function ForkUpdatesOffSetting({
  appVersion
}: {
  appVersion: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={t(
        'auto.components.settings.GeneralUpdateSettingsSection.6d27bd46e3',
        'Check for updates'
      )}
      description={t(
        'forkBuild.updatesOff',
        'Self-update is off in this fork build. Get new versions from github.com/vbalien/orca/releases.'
      )}
      keywords={['about', 'update', 'version', 'release notes', 'download', 'fork']}
      className="space-y-3 py-3"
    >
      <span className="text-sm">
        {t('settings.general.about.version', 'Orca {{version}}', { version: appVersion ?? '…' })}
      </span>
      <p className="text-xs text-muted-foreground">
        {t(
          'forkBuild.updatesOff',
          'Self-update is off in this fork build. Get new versions from github.com/vbalien/orca/releases.'
        )}{' '}
        <a
          href={FORK_RELEASES_URL}
          target="_blank"
          onClick={openAppHttpLinkFromAnchor}
          rel="noopener noreferrer"
          className="whitespace-nowrap underline hover:text-foreground"
        >
          {t('forkBuild.releasesLink', 'Fork releases')}
        </a>
      </p>
    </SearchableSetting>
  )
}
