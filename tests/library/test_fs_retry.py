import errno
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from easyread.library import fs_retry, store


class FsRetryTest(unittest.TestCase):
    def test_transient_invalid_argument_recovers(self):
        operation = Mock(side_effect=[OSError(errno.EINVAL, 'sync busy'), 42])
        with patch.object(fs_retry.os, 'name', 'nt'), patch.object(fs_retry.time, 'sleep'):
            self.assertEqual(fs_retry.retry_write(operation), 42)

    def test_persistent_error_is_reported_after_bounded_retries(self):
        operation = Mock(side_effect=OSError(errno.EINVAL, 'invalid path'))
        with patch.object(fs_retry.os, 'name', 'nt'), patch.object(fs_retry.time, 'sleep'):
            with self.assertRaises(OSError):
                fs_retry.retry_write(operation)
        self.assertEqual(operation.call_count, 5)

    def test_existing_lock_is_never_bypassed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with store.dir_lock(root):
                with self.assertRaises(TimeoutError):
                    with store.dir_lock(root, timeout=0):
                        self.fail('entered a locked directory')
                self.assertTrue((root / '.write.lock').exists())
            self.assertFalse((root / '.write.lock').exists())

    def test_lock_write_failure_closes_descriptor_and_removes_only_owned_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(store.os, 'write', side_effect=OSError(errno.ENOSPC, 'disk full')), \
                    patch.object(store.os, 'close', wraps=os.close) as close:
                with self.assertRaises(OSError):
                    with store.dir_lock(root):
                        self.fail('entered without lock owner written')
            close.assert_called_once()
            self.assertFalse((root / '.write.lock').exists())
