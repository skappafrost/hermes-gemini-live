"""A call's authenticated renderer bridge. Never creates an API worker.

Renderer receipts outlive this socket; losing a response is uncertain delivery,
not permission to replay a coding request through a second execution lane.
"""
import asyncio
import json


class NativeLane:
    def __init__(self, browser, timeout=25):
        self.browser = browser
        self.timeout = timeout
        self.pending = {}

    async def request(self, request_id, action, payload=None):
        future = self.pending.get(request_id)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            self.pending[request_id] = future
            await self.browser.send_text(json.dumps({'type': 'native_request',
                'id': request_id, 'action': action, 'payload': payload or {}}))
        try:
            return await asyncio.wait_for(asyncio.shield(future), self.timeout)
        except asyncio.TimeoutError:
            result = {'status': 'uncertain', 'detail':
                'Native delivery could not be confirmed. Check this chat; do not resubmit automatically.'}
            if not future.done():
                future.set_result(result)
            return future.result()

    def receive(self, frame):
        future = self.pending.get(str(frame.get('id') or ''))
        if future is not None and not future.done():
            future.set_result(frame.get('result') or {'status': 'rejected'})
