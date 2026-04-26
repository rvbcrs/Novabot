"""HTTP client periodically POSTs to the server. Test the body shape
and the error tolerance — a failed POST must not stop the loop."""
from unittest.mock import MagicMock, patch

import pytest

from http_client import HttpClient


def test_net_check_posts_to_correct_endpoint():
    cli = HttpClient(host='192.168.0.222', port=80, sn='LFIN1231000211')
    with patch('http_client.requests.post') as mock_post:
        mock_post.return_value = MagicMock(status_code=200, text='OK')
        cli.net_check_once()
    args, kwargs = mock_post.call_args
    assert args[0] == 'http://192.168.0.222:80/api/nova-network/network/connection'
    body = kwargs.get('json', {})
    assert body.get('sn') == 'LFIN1231000211'


def test_net_check_swallows_connection_errors():
    cli = HttpClient(host='unreachable', port=80, sn='LFIN1231000211')
    with patch('http_client.requests.post', side_effect=Exception('refused')):
        cli.net_check_once()  # must not raise
