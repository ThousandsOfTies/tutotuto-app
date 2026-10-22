import { useAppTranslation } from '../../i18n'
import type { StarterLanguage } from '../../services/starterMaterial'
import './StarterLanguageChoice.css'

export function StarterLanguageChoice({ onSelect, busy }: {
  onSelect: (language: StarterLanguage) => void
  busy: boolean
}) {
  const { i18n } = useAppTranslation()
  // Both languages remain visible before the user has chosen a UI language.
  const ja = i18n.getFixedT('ja', 'tutotuto')
  const en = i18n.getFixedT('en', 'tutotuto')

  return <main className="starter-language" aria-busy={busy}>
    <div className="starter-language-content">
      <h1>
        <span lang="ja">{ja('onboarding.title')}</span>
        <span lang="en">{en('onboarding.title')}</span>
      </h1>
      <p className="starter-language-description">
        <span lang="ja">{ja('onboarding.description')}</span>
        <span lang="en">{en('onboarding.description')}</span>
      </p>
      <div className="starter-language-options">
        <button type="button" lang="ja" disabled={busy} onClick={() => onSelect('ja')}>
          {ja('onboarding.japanese')}
        </button>
        <button type="button" lang="en" disabled={busy} onClick={() => onSelect('en')}>
          {en('onboarding.english')}
        </button>
      </div>
      <p className="starter-language-note">
        <span lang="ja">{ja('onboarding.note')}</span>
        <span lang="en">{en('onboarding.note')}</span>
      </p>
      {busy && <p className="starter-language-status" role="status">
        <span lang="ja">{ja('onboarding.preparing')}</span>
        <span lang="en">{en('onboarding.preparing')}</span>
      </p>}
    </div>
  </main>
}
