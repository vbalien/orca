// One validation problem of the Jev gate JSON, in the reader's language: what is wrong, where.
import type { useTranslate } from '@/i18n/use-translate'
import {
  formatSlackGateJevPath,
  type SlackGateJevTextIssue
} from '../../../../../../shared/bots/slack-gate-jev-text'

type Translate = ReturnType<typeof useTranslate>

function what(t: Translate, issue: SlackGateJevTextIssue): string {
  const p = issue.params ?? {}
  switch (issue.code) {
    case 'syntax':
      return t('bots.slack.gate.jev.issue.syntax', 'This is not valid JSON.')
    case 'duplicate_key':
      return t('bots.slack.gate.jev.issue.duplicateKey', '“{{key}}” appears twice.', p)
    case 'too_deep':
      return t('bots.slack.gate.jev.issue.tooDeep', 'Nested more than {{max}} levels deep.', p)
    case 'text_too_large':
    case 'too_large':
      return t('bots.slack.gate.jev.issue.tooLarge', 'Too large: at most {{max}} bytes.', p)
    case 'not_object':
      return t('bots.slack.gate.jev.issue.notObject', 'Must be an object { … }.')
    case 'not_string':
      return t('bots.slack.gate.jev.issue.notString', 'Must be text in quotes.')
    case 'not_number':
      return t('bots.slack.gate.jev.issue.notNumber', 'Must be a number.')
    case 'not_array':
      return t('bots.slack.gate.jev.issue.notArray', 'Must be a list [ … ].')
    case 'not_boolean_or_number':
      return t(
        'bots.slack.gate.jev.issue.notBoolean',
        'Must be true, false, or (for lists) a number.'
      )
    case 'unknown_key':
      return t('bots.slack.gate.jev.issue.unknownKey', 'Not a field this gate knows.')
    case 'required':
      return t('bots.slack.gate.jev.issue.required', 'This field is required.')
    case 'blank':
      return t('bots.slack.gate.jev.issue.blank', 'Must not be blank.')
    case 'too_long':
      return t('bots.slack.gate.jev.issue.tooLong', 'At most {{max}} characters.', p)
    case 'not_finite':
      return t('bots.slack.gate.jev.issue.notFinite', 'Must be a finite number.')
    case 'out_of_range':
      return t('bots.slack.gate.jev.issue.outOfRange', 'Must be between {{min}} and {{max}}.', p)
    case 'bad_name':
      return t(
        'bots.slack.gate.jev.issue.badName',
        'Question names start with a letter and use letters, digits and _ (up to 40).'
      )
    case 'count':
      return p.max === undefined
        ? t('bots.slack.gate.jev.issue.countMin', 'Needs at least {{min}}.', p)
        : t('bots.slack.gate.jev.issue.count', 'Needs {{min}} to {{max}} entries.', p)
    case 'question_type':
      return t('bots.slack.gate.jev.issue.questionType', 'type must be noul, choice or score.')
    case 'box_unsupported':
      return t('bots.slack.gate.jev.issue.box', 'Box questions are not supported for Slack gates.')
    case 'assets_unsupported':
      return t(
        'bots.slack.gate.jev.issue.assets',
        'Images (assets) are not supported for Slack gates.'
      )
    case 'extra_collision':
      return t(
        'bots.slack.gate.jev.issue.extraCollision',
        'This name is taken by an event fact; choose another.'
      )
    case 'unknown_question':
      return t(
        'bots.slack.gate.jev.issue.unknownQuestion',
        'No question is named “{{question}}”.',
        p
      )
    case 'one_effect':
      return t(
        'bots.slack.gate.jev.issue.oneEffect',
        'A rule needs exactly one of wakeIf or blockIf.'
      )
    case 'condition_kind':
      return t(
        'bots.slack.gate.jev.issue.conditionKind',
        'Use { "atLeast": n } or { "atMost": n } for noul and score, { "oneOf": [ … ] } for choice.'
      )
    case 'condition_for_choice':
      return t(
        'bots.slack.gate.jev.issue.conditionForChoice',
        'A choice question takes { "oneOf": [ … ] }.'
      )
    case 'unknown_choice':
      return t(
        'bots.slack.gate.jev.issue.unknownChoice',
        '“{{choice}}” is not one of its choices.',
        p
      )
    case 'duplicate_choice':
      return t('bots.slack.gate.jev.issue.duplicateChoice', '“{{choice}}” is listed twice.', p)
    case 'unsure_side':
      return t(
        'bots.slack.gate.jev.issue.unsureSide',
        'unsureFrom must be below atLeast, or above atMost.'
      )
    case 'unsure_choice':
      return t(
        'bots.slack.gate.jev.issue.unsureChoice',
        'unsureFrom works only with atLeast or atMost.'
      )
    case 'unused_question':
      return t('bots.slack.gate.jev.issue.unused', 'No rule uses “{{question}}”.', p)
    case 'enum':
      return t('bots.slack.gate.jev.issue.enum', 'Must be one of: {{allowed}}.', p)
    case 'legacy_mixed':
      return t(
        'bots.slack.gate.jev.issue.legacyMixed',
        'Add "questions" and "rules" to use this field.'
      )
  }
}

export function slackGateJevIssueText(t: Translate, issue: SlackGateJevTextIssue): string {
  const path = formatSlackGateJevPath(issue.path)
  const where = [
    issue.line !== undefined
      ? t('bots.slack.gate.jev.line', 'Line {{line}}', { line: issue.line })
      : '',
    path
  ]
    .filter(Boolean)
    .join(' · ')
  return where ? `${where}: ${what(t, issue)}` : what(t, issue)
}
