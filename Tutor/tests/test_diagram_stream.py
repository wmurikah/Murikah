"""Diagram streaming, validation, failure cleanup and quota regression coverage."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from test_provider_stream import fast

source = Path(__file__).resolve().parents[1] / 'railway/murikah_diagram.py'
if not source.exists(): source = Path('/app/deeptutor/murikah_diagram.py')
spec = importlib.util.spec_from_file_location('diagram_under_test', source)
diagram = importlib.util.module_from_spec(spec)
from test_er_diagram import er
with patch.dict(sys.modules, {'deeptutor.murikah_fast_lane': fast, 'deeptutor.murikah_er': er}):
    spec.loader.exec_module(diagram)

SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="20">Course</text></svg>'

class DiagramTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, stream):
        return [json.loads(item) async for item in stream]

    async def test_progress_arrives_before_model_selection_and_complete_svg_commits(self):
        closed = []
        async def model():
            try:
                yield SVG[:40]
                yield SVG[40:]
            finally: closed.append(True)
        with patch.object(diagram, 'candidates_for', return_value=[fast.HedgeCandidate('healthy', 0, model)]) as build:
            stream = diagram.diagram_events('Courses', 'Draw', {})
            first = json.loads(await anext(stream))
            self.assertEqual(first['type'], 'status')
            build.assert_not_called()
            events = await self.collect(stream)
        self.assertEqual(events[-1], {'type': 'done', 'answer': SVG})
        self.assertTrue(any(e.get('characters', 0) > 0 for e in events))
        self.assertEqual(closed, [True])

    async def test_overload_falls_back_without_showing_raw_error(self):
        async def bad():
            yield "Error: {'code': 529}"
        async def good():
            yield SVG
        candidates = [fast.HedgeCandidate('bad', 0, lambda: fast.validated_stream(bad())),
                      fast.HedgeCandidate('good', .001, good)]
        with patch.object(diagram, 'candidates_for', return_value=candidates):
            events = await self.collect(diagram.diagram_events('Courses', 'Draw', {}))
        self.assertEqual(events[-1]['answer'], SVG)
        self.assertNotIn('529', json.dumps(events))

    async def test_truncated_svg_is_an_error_and_refundable(self):
        async def model(): yield '<svg viewBox="0 0 10 10"><text>'
        scope = {}
        with patch.object(diagram, 'candidates_for', return_value=[fast.HedgeCandidate('bad', 0, model)]):
            events = await self.collect(diagram.diagram_events('Courses', 'Draw', scope))
        self.assertEqual(events[-1]['type'], 'error')
        self.assertTrue(scope['murikah_prompt_failed'])
        self.assertFalse(any(e['type'] == 'done' for e in events))

    async def test_stalled_stream_terminates_and_closes_provider(self):
        closed = []
        async def model():
            try:
                yield '<svg'
                await asyncio.Event().wait()
            finally: closed.append(True)
        with patch.object(diagram, 'IDLE_SECONDS', .01), patch.object(diagram, 'candidates_for', return_value=[fast.HedgeCandidate('stall', 0, model)]):
            events = await self.collect(diagram.diagram_events('Courses', 'Draw', {}))
        self.assertEqual(events[-1]['type'], 'error')
        self.assertEqual(events[-1]['code'], 'timeout')
        self.assertEqual(closed, [True])

    async def test_disconnect_cancels_provider(self):
        closed = []
        async def model():
            try:
                yield '<svg'
                await asyncio.Event().wait()
            finally: closed.append(True)
        scope = {}
        with patch.object(diagram, 'candidates_for', return_value=[fast.HedgeCandidate('stall', 0, model)]):
            stream = diagram.diagram_events('Courses', 'Draw', scope)
            await anext(stream)
            await anext(stream)
            task = asyncio.create_task(anext(stream))
            await asyncio.sleep(.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(scope['murikah_prompt_failed'])
        self.assertEqual(closed, [True])

    async def test_fast_incomplete_reply_does_not_cancel_valid_backup(self):
        async def broken():
            yield 'Here is your diagram: <svg viewBox="0 0 10 10"><text>'
        async def backup():
            await asyncio.sleep(.01)
            yield SVG
        candidates = [fast.HedgeCandidate('broken', 0, broken), fast.HedgeCandidate('backup', 0, backup)]
        scope = {}
        with patch.object(diagram, 'candidates_for', return_value=candidates):
            events = await self.collect(diagram.diagram_events('Order to fulfilment', 'Draw', scope))
        self.assertEqual(events[-1]['answer'], SVG)
        self.assertTrue(scope['murikah_prompt_completed'])
        self.assertFalse(scope.get('murikah_prompt_failed'))

    async def test_valid_backup_wins_even_while_first_provider_stalls(self):
        closed = []
        async def stalled():
            try:
                yield 'Here is your diagram: '
                await asyncio.Event().wait()
            finally: closed.append(True)
        async def backup():
            await asyncio.sleep(.01)
            yield SVG
        with patch.object(diagram, 'candidates_for', return_value=[
            fast.HedgeCandidate('stalled', 0, stalled), fast.HedgeCandidate('backup', 0, backup),
        ]):
            events = await self.collect(diagram.diagram_events('Order to fulfilment', 'Draw', {}))
        self.assertEqual(events[-1]['answer'], SVG)
        self.assertEqual(closed, [True])

    def test_normalizes_label_entities_without_inventing_missing_content(self):
        answer = SVG.replace('Course', 'Order & fulfilment&nbsp;&mdash; delivery &amp; returns')
        normalized = diagram.validate_answer(answer)
        self.assertIn('Order &amp; fulfilment&#160;&#8212; delivery &amp; returns', normalized)
        self.assertEqual(diagram.validate_answer(normalized), normalized)

    async def test_reported_finance_er_prompt_uses_json_and_renders_without_model_svg(self):
        from test_er_diagram import FINANCE
        captured = []
        async def model():
            payload = json.dumps(FINANCE)
            for i in range(0, len(payload), 60): yield payload[i:i+60]
        def candidates(messages):
            captured.extend(messages)
            return [fast.HedgeCandidate('planner', 0, model)]
        with patch.object(diagram, 'candidates_for', side_effect=candidates):
            events = await self.collect(diagram.diagram_events('Design ER diagram for a finance database', 'Legacy SVG prompt', {}))
        self.assertEqual(events[-1]['type'], 'done')
        self.assertIn('<svg', events[-1]['answer'])
        self.assertIn('Account.account_id', events[-1]['answer'])
        self.assertIn('Return ONLY one compact JSON object', captured[0]['content'])
        self.assertNotIn('Legacy SVG prompt', captured[0]['content'])

    def test_invalid_xml_is_rejected(self):
        with self.assertRaises(Exception): diagram.validate_answer('<svg viewBox="0 0 1 1"><g></svg>')
        with self.assertRaises(ValueError): diagram.validate_answer('<svg></svg>')
