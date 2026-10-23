#!/usr/bin/env python3
"""Build a read-only iPhone shortcut. Sign with Apple's `shortcuts sign` on macOS.

Health filter schema follows exported iOS Shortcuts (Type enumeration predicate).
The mock variant exercises the same loops/JSON encoding without touching Health.
"""
import argparse
import datetime as dt
import json
import plistlib
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = 'WEDX — Здоровье'
ENDPOINT = 'https://lhwvpjaatsroijgozoro.supabase.co/functions/v1/health-import'


def state(kind, value):
    return {'WFSerializationType': kind, 'Value': value}


def text(*parts):
    if len(parts) == 1 and isinstance(parts[0], dict) and parts[0].get('WFSerializationType') == 'WFTextTokenString':
        return parts[0]
    string, attachments = '', {}
    for part in parts:
        if isinstance(part, dict):
            offset = len(string.encode('utf-16-le')) // 2
            attachments['{%s, 1}' % offset] = part.get('Value', part)
            string += '\ufffc'
        else:
            string += str(part)
    return state('WFTextTokenString', {'string': string, 'attachmentsByRange': attachments})


def variable(name):
    return state('WFTextTokenAttachment', {'Type': 'Variable', 'VariableName': name})


def dictionary(values):
    items = []
    for key, value, numeric in values:
        # Numbers use item type 3 (1 means a nested dictionary) and token strings.
        # The wrong type crashes Shortcuts during import (WFPropertyListParameterValue).
        encoded = text(value)
        items.append({'WFItemType': 3 if numeric else 0, 'WFKey': text(key), 'WFValue': encoded})
    return state('WFDictionaryFieldValue', {'WFDictionaryFieldValueItems': items})


def build(token='', mock=False):
    actions = []

    def add(name, output='Result', **params):
        uid = str(uuid.uuid4()).upper()
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + name,
                        'WFWorkflowActionParameters': {'UUID': uid, **params}})
        return state('WFTextTokenAttachment', {'Type': 'ActionOutput', 'OutputUUID': uid, 'OutputName': output})

    def get_key(key, input):
        return add('getvalueforkey', 'Dictionary Value', WFGetDictionaryValueType='Value', WFDictionaryKey=key, WFInput=input)

    def format_date(input, pattern='yyyy-MM-dd'):
        return add('format.date', 'Formatted Date', WFDate=text(input), WFDateFormatStyle='Custom', WFDateFormat=pattern, WFLocale='en_US_POSIX')

    add('comment', WFCommentActionText='WEDX · Apple «Здоровье». Дневные итоги за 8 дней: съеденные ккал, белок, углеводы, жиры и активная энергия. '
        'Используется встроенная группировка «По дням», без перебора каждой записи. Пропуски не заполняются нулями. '
        'Первый запуск — на разблокированном iPhone. Разреши чтение пяти показателей и отправку в свой WEDX. '
        'После запуска сверь сегодняшний день с «Здоровьем». Дневная норма задаётся отдельно в WEDX. Команда ничего не записывает в «Здоровье».')
    key = add('gettext', 'Text', WFTextActionText=token or 'ВСТАВЬ_КЛЮЧ_ИЗ_WEDX')
    now = add('date', 'Date', WFDateActionMode='Current Date')
    end = format_date(now)
    start_raw = add('adjustdate', 'Adjusted Date', WFDate=text(now), WFAdjustOperation='Subtract',
                    WFDuration=state('WFQuantityFieldValue', {'Magnitude': '7', 'Unit': 'days'}))
    start = format_date(start_raw)
    fixtures = None
    if mock:
        today = dt.datetime.now().astimezone().strftime('%Y-%m-%d')
        yesterday = (dt.datetime.now().astimezone() - dt.timedelta(days=1)).strftime('%Y-%m-%d')
        sample = lambda day, value, unit, source='YAZIO': {'date': day + 'T12:00:00', 'value': value, 'unit': unit, 'source': source}
        data = {'energy': [sample(today, 1321, 'kcal'), sample(yesterday, 2000, 'kcal')],
                'protein': [sample(today, 58, 'g'), sample(yesterday, 100, 'g')],
                'carbs': [sample(today, 121, 'g')], 'fat': [sample(today, 70, 'g')],
                'activity': [{**sample(today, 90, 'kcal'), 'end': today + 'T12:10:00'}]}
        fixture_text = add('gettext', 'Text', WFTextActionText=json.dumps(data))
        fixtures = add('detect.dictionary', 'Dictionary', WFInput=fixture_text)

    def samples(kind, label):
        if mock:
            found = get_key(kind, fixtures)
        else:
            filters = state('WFContentPredicateTableTemplate', {
                'WFActionParameterFilterPrefix': 1, 'WFContentPredicateBoundedDate': False,
                'WFActionParameterFilterTemplates': [
                    {'Bounded': True, 'Operator': 4, 'Property': 'Type', 'Removable': False,
                     'Values': {'Enumeration': state('WFStringSubstitutableState', label)}},
                    {'Bounded': True, 'Operator': 1001, 'Property': 'Start Date', 'Removable': True,
                     'Values': {'Number': '8', 'Unit': 16}},
                ],
            })
            found = add('filter.health.quantity', 'Health Samples', WFContentItemFilter=filters,
                        WFContentItemLimitEnabled=False, WFHKSampleFilteringFillMissing=False, WFHKSampleFilteringGroupBy='Day',
                        WFContentItemSortProperty='Start Date', WFContentItemSortOrder='Oldest First')
        loop = str(uuid.uuid4()).upper()
        add('repeat.each', GroupingIdentifier=loop, WFControlFlowMode=0, WFInput=found)
        item = variable('Repeat Item')

        def detail(name):
            if mock:
                return get_key({'Source': 'source', 'Value': 'value', 'Unit': 'unit', 'Start Date': 'date', 'End Date': 'end'}[name], item)
            return add('properties.health.quantity', name, WFContentItemPropertyName=name, WFInput=item)

        day = format_date(detail('Start Date'))
        amount = detail('Value')
        unit = detail('Unit')
        row = add('dictionary', 'Dictionary', WFItems=dictionary([
            ('date', day, False), ('value', amount, True), ('unit', unit, False)]))
        add('gettext', 'Text', WFTextActionText=text(row))
        results = add('repeat.each', 'Repeat Results', GroupingIdentifier=loop, WFControlFlowMode=2)
        return add('text.combine', 'Combined Text', text=text(results), WFTextSeparator='Custom', WFTextCustomSeparator=',')

    energy = samples('energy', 'Dietary Calories')
    protein = samples('protein', 'Protein')
    carbs = samples('carbs', 'Carbohydrates')
    fat = samples('fat', 'Total Fat')
    activity = samples('activity', 'Active Calories')
    payload = add('gettext', 'Text', WFTextActionText=text(
        '{"version":4,"source":"apple-health","aggregation":"day","startDate":"', start,
        '\",\"endDate\":\"', end, '\",\"energyTotals\":[', energy, '],\"proteinTotals\":[', protein,
        '],\"carbsTotals\":[', carbs, '],\"fatTotals\":[', fat, '],\"activityTotals\":[', activity, ']}'))
    if not mock:
        # File bodies require a direct attachment; wrapping it in text() sends no body.
        response = add('downloadurl', 'Contents of URL', WFURL=ENDPOINT, WFHTTPMethod='POST', WFHTTPBodyType='File',
                       WFRequestVariable=payload, WFHTTPHeaders=dictionary([
                           ('Content-Type', 'application/json', False), ('Authorization', text('Bearer ', key), False),
                       ]))
        message = get_key('message', response)
        add('notification', WFNotificationActionTitle='WEDX · Здоровье', WFNotificationActionBody=text(message), WFNotificationActionSound=False)
    workflow = {
        'WFWorkflowName': 'WEDX проверка формата' if mock else NAME,
        'WFWorkflowClientVersion': '2600.0.4', 'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900', 'WFWorkflowHasOutputFallback': False,
        'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 61440, 'WFWorkflowIconStartColor': 4282601983},
        'WFWorkflowInputContentItemClasses': [], 'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowTypes': [], 'WFWorkflowActions': actions, 'WFWorkflowImportQuestions': [],
    }
    if not token and not mock:
        workflow['WFWorkflowImportQuestions'] = [{
            'Category': 'Parameter', 'ActionIndex': 1, 'ParameterKey': 'WFTextActionText',
            'Text': 'В WEDX открой «Подключения и питание», скопируй существующий ключ из старой команды или создай новый. Вставь его сюда (начинается с wedx_).',
            'DefaultValue': '',
        }]
    return workflow


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--token-file', help='Private JSON with a token field; output must stay in .local/')
    parser.add_argument('--mock', action='store_true')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    token = ''
    if args.token_file:
        if not output.is_relative_to(ROOT / '.local'):
            parser.error('A personal shortcut must stay in the ignored .local directory.')
        token = json.loads(Path(args.token_file).read_text())['token']
        if not __import__('re').fullmatch(r'wedx_[a-f0-9]{64}', token):
            parser.error('Invalid integration token')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(plistlib.dumps(build(token, args.mock), fmt=plistlib.FMT_BINARY, sort_keys=False))
    if token:
        output.chmod(0o600)
    print(f'Created {output.name}')
