#!/usr/bin/env python3
"""Separate, read-only sleep bridge. Nutrition's selected Watch stays untouched.

Uses the observed Find Health Samples Type predicate and raw detail schema.
Apple Health actions require an iPhone; signing is not a device runtime test.
"""
import argparse
import importlib.util
import json
import plistlib
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('health_builder', ROOT / 'scripts/build-health-shortcut.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
state, text, variable, dictionary = base.state, base.text, base.variable, base.dictionary
NAME = 'WEDX — Сон'
ENDPOINT = 'https://lhwvpjaatsroijgozoro.supabase.co/functions/v1/sleep-import'
METRICS = [('sleep', 'Sleep', 'Стадии сна'), ('hrv', 'Heart Rate Variability', 'Вариабельность пульса'),
           ('respiratory_rate', 'Respiratory Rate', 'Дыхание'), ('heart_rate', 'Heart Rate', 'Пульс')]


def build():
    actions = []

    def add(name, output='Result', **params):
        uid = str(uuid.uuid4()).upper()
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + name,
                        'WFWorkflowActionParameters': {'UUID': uid, **params}})
        return state('WFTextTokenAttachment', {'Type': 'ActionOutput', 'OutputUUID': uid, 'OutputName': output})

    add('comment', WFCommentActionText='WEDX · Сон · версия 2. Читает последние 3 дня: стадии сна, пульс, вариабельность пульса, дыхание. '
        'Первый запуск — на разблокированном iPhone. Разреши чтение показателей и отправку в WEDX. '
        'Источники сохраняются отдельно. Данные «Здоровья» команда не меняет. '
        'Температуру запястья и нарушения дыхания можно добавить через экспорт «Здоровья» в разделе «Сон».')
    key = add('gettext', 'Text', WFTextActionText='ВСТАВЬ_КЛЮЧ_СНА_ИЗ_WEDX')
    for step, (metric, label, title) in enumerate(METRICS, 1):
        add('notification', WFNotificationActionTitle=f'WEDX · Сон · {step}/4',
            WFNotificationActionBody=f'{title}: читаем «Здоровье»…', WFNotificationActionSound=False)
        filters = state('WFContentPredicateTableTemplate', {'WFActionParameterFilterPrefix': 1,
            'WFContentPredicateBoundedDate': False, 'WFActionParameterFilterTemplates': [
                {'Bounded': True, 'Operator': 4, 'Property': 'Type', 'Removable': False,
                 'Values': {'Enumeration': state('WFStringSubstitutableState', label)}},
                {'Bounded': True, 'Operator': 1001, 'Property': 'Start Date', 'Removable': True,
                 'Values': {'Number': '3', 'Unit': 16}},
            ]})
        found = add('filter.health.quantity', 'Health Samples', WFContentItemFilter=filters,
                    WFContentItemLimitEnabled=False, WFHKSampleFilteringFillMissing=False,
                    WFContentItemSortProperty='Start Date', WFContentItemSortOrder='Oldest First')
        count = add('count', 'Count', WFCountType='Items', Input=found)
        add('notification', WFNotificationActionTitle=f'WEDX · Сон · {step}/4 · {title}',
            WFNotificationActionBody=text('Найдено записей: ', count, '. Подготавливаем отправку.'), WFNotificationActionSound=False)
        loop = str(uuid.uuid4()).upper()
        add('repeat.each', GroupingIdentifier=loop, WFControlFlowMode=0, WFInput=found)
        item = variable('Repeat Item')

        def detail(name):
            return add('properties.health.quantity', name, WFContentItemPropertyName=name, WFInput=item)

        def date(name):
            return add('format.date', 'Formatted Date', WFDate=text(detail(name)), WFDateFormatStyle='Custom',
                       WFDateFormat="yyyy-MM-dd'T'HH:mm:ss.SSSXXX", WFLocale='en_US_POSIX')

        start, end = date('Start Date'), date('End Date')
        source, value = detail('Source'), detail('Value')
        unit = '' if metric == 'sleep' else detail('Unit')
        row = add('dictionary', 'Dictionary', WFItems=dictionary([
            ('metric', metric, False), ('start', start, False), ('end', end, False),
            ('source', source, False), ('value', value, False), ('unit', unit, False)]))
        add('gettext', 'Text', WFTextActionText=text(row))
        results = add('repeat.each', 'Repeat Results', GroupingIdentifier=loop, WFControlFlowMode=2)
        joined = add('text.combine', 'Combined Text', text=text(results), WFTextSeparator='Custom', WFTextCustomSeparator=',')
        body = add('gettext', 'Text', WFTextActionText=text('{"version":1,"source":"apple-health","samples":[', joined, ']}'))
        response = add('downloadurl', 'Contents of URL', WFURL=ENDPOINT, WFHTTPMethod='POST', WFHTTPBodyType='File',
                       WFRequestVariable=body, WFHTTPHeaders=dictionary([
                           ('Content-Type', 'application/json', False), ('Authorization', text('Bearer ', key), False)]))
        message = add('getvalueforkey', 'Dictionary Value', WFGetDictionaryValueType='Value', WFDictionaryKey='message', WFInput=response)
        status = add('getvalueforkey', 'Dictionary Value', WFGetDictionaryValueType='Value', WFDictionaryKey='status', WFInput=response)
        guard = str(uuid.uuid4()).upper()
        add('conditional', GroupingIdentifier=guard, WFControlFlowMode=0, WFCondition=4,
            WFInput={'Type': 'Variable', 'Variable': status}, WFConditionalActionString='imported')
        add('notification', WFNotificationActionTitle=f'WEDX · Сон · {step}/4 · {title}',
            WFNotificationActionBody=text(message), WFNotificationActionSound=False)
        add('conditional', GroupingIdentifier=guard, WFControlFlowMode=1)
        add('notification', WFNotificationActionTitle=f'WEDX · Сон · Не сохранено: {title}',
            WFNotificationActionBody=text(message, '\nИмпорт остановлен. Уже принятые записи сохранены.'), WFNotificationActionSound=False)
        add('exit')
        add('conditional', GroupingIdentifier=guard, WFControlFlowMode=2)
    add('notification', WFNotificationActionTitle='WEDX · Сон · Готово',
        WFNotificationActionBody='Все четыре этапа завершены. Открой раздел «Сон» в WEDX.', WFNotificationActionSound=False)
    return {'WFWorkflowName': NAME, 'WFWorkflowClientVersion': '2600.0.4', 'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900', 'WFWorkflowHasOutputFallback': False,
        'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 61440, 'WFWorkflowIconStartColor': 4251333119},
        'WFWorkflowInputContentItemClasses': [], 'WFWorkflowOutputContentItemClasses': [], 'WFWorkflowTypes': [],
        'WFWorkflowActions': actions, 'WFWorkflowImportQuestions': [{'Category': 'Parameter', 'ActionIndex': 1,
            'ParameterKey': 'WFTextActionText', 'Text': 'В WEDX → Сон → Подключить сон создай ключ, скопируй и вставь сюда (wedx_).', 'DefaultValue': ''}]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(plistlib.dumps(build(), fmt=plistlib.FMT_BINARY, sort_keys=False))
    print('Created', output.name)
