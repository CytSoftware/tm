from contextlib import contextmanager
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tasks.models import Column, Project, StateTransition, Task
from .github import GitHubUnavailable
from .models import ProjectRepository, PullRequestSnapshot, TaskPullRequest
from .promotions import contains
from .services import apply_pull_request_event, apply_pull_request_review_event
from .tests import _pr_payload


class MergeWorkflowTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user('dev')
        self.project = Project.objects.create(name='Mowafeq', prefix='CYT')
        self.repo = ProjectRepository.objects.create(project=self.project, repo_id=999, repo_full_name='owner/repo')
        self.dev = Column.objects.create(project=self.project, name='In Dev', kind='review', order=5)
        self.task = self.new_task('One')
        self.read = Mock(return_value={'status': 'ahead'})
        @contextmanager
        def reader(repo_id):
            self.assertEqual(repo_id, 999)
            yield self.read
        self.patch = patch('apps.integrations.promotions.repository_reader', reader)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def new_task(self, title):
        return Task.objects.create(project=self.project, title=title, reporter=self.user,
                                   column=self.project.columns.get(kind='todo'))

    def payload(self, *, number=1, task=None, base='dev', merged=True, head='feature', sha='a', date='2026-09-17T10:00:00Z'):
        task = task or self.task
        p = _pr_payload(number=number, title=f'[{task.key}] change', head_ref=head, base_ref=base,
                        merged=merged, state='closed' if merged else 'open')
        pr = p['pull_request']
        pr.update(updated_at=date, merged_at=date if merged else None, merge_commit_sha=sha * 40 if merged else None)
        pr['head'].update(sha='f' * 40, repo={'id':999})
        pr['base']['repo'] = {'id':999}
        return p

    def column(self, task=None):
        task = task or self.task
        task.refresh_from_db()
        return task.column.name

    def promotion(self, number=10):
        p = self.payload(number=number, base='main', head='dev', date='2026-09-17T11:00:00Z')
        p['pull_request']['title'] = 'Release'
        return p

    def test_dev_merge_and_duplicate(self):
        p = self.payload()
        self.assertEqual(apply_pull_request_event(p, 'closed').tasks_moved, 1)
        self.assertEqual(self.column(), 'In Dev')
        self.assertEqual(apply_pull_request_event(p, 'closed').tasks_moved, 0)
        self.assertEqual(StateTransition.objects.filter(task=self.task, source='github').count(), 1)

    def test_missing_in_dev_and_unmapped_branch_do_not_complete(self):
        self.dev.delete()
        apply_pull_request_event(self.payload(), 'closed')
        self.assertEqual(self.column(), 'Todo')
        apply_pull_request_event(self.payload(number=2, base='staging'), 'closed')
        self.assertEqual(self.column(), 'Todo')

    def test_approval_keeps_review_and_changes_requested_returns_to_progress(self):
        p = self.payload(merged=False)
        apply_pull_request_event(p, 'review_requested')
        self.assertEqual(self.column(), 'In Review')
        for state, expected in [('approved','In Review'), ('changes_requested','In Progress')]:
            apply_pull_request_review_event({**p, 'action':'submitted', 'review': {'state': state}})
            self.assertEqual(self.column(), expected)

    def test_main_merge_completes_but_closed_unmerged_does_not(self):
        p = self.payload(base='main', merged=False)
        p['pull_request']['state']='closed'
        apply_pull_request_event(p, 'closed')
        self.assertEqual(self.column(), 'Todo')
        apply_pull_request_event(self.payload(number=2, base='main'), 'closed')
        self.assertEqual(self.column(), 'Done')

    def test_late_body_link_applies_merge_without_closed_action(self):
        p = self.payload()
        p['pull_request']['title'] = 'No task reference'
        apply_pull_request_event(p, 'closed')
        self.assertEqual(self.column(), 'Todo')
        p['pull_request']['body'] = f'### Related CytHQ tasks\n- [{self.task.key}](https://hq.cytsoftware.com/board?task={self.task.key})'
        p['pull_request']['updated_at'] = '2026-09-17T10:01:00Z'
        apply_pull_request_event(p, 'edited')
        self.assertEqual(self.column(), 'In Dev')

    def test_stale_event_cannot_erase_merge_or_links(self):
        p = self.payload()
        apply_pull_request_event(p, 'closed')
        stale = self.payload(merged=False, date='2026-09-17T09:00:00Z')
        stale['pull_request']['title'] = 'No references'
        apply_pull_request_event(stale, 'edited')
        link = TaskPullRequest.objects.get(task=self.task)
        self.assertTrue(link.merged)
        self.assertEqual(self.column(), 'In Dev')
        self.assertTrue(PullRequestSnapshot.objects.get(pr_number=1).payload['merged'])

    def test_review_or_delayed_dev_merge_does_not_regress_promoted_work(self):
        apply_pull_request_event(self.payload(), 'closed')
        p = self.payload(number=2, base='main', head='dev', merged=False)
        apply_pull_request_event(p, 'review_requested')
        apply_pull_request_review_event({**p, 'action':'submitted', 'review': {'state':'changes_requested'}})
        self.assertEqual(self.column(), 'In Dev')
        apply_pull_request_event(self.payload(number=3, base='main'), 'closed')
        apply_pull_request_event(self.payload(number=4), 'closed')
        self.assertEqual(self.column(), 'Done')

    def test_promotion_without_ids_moves_only_contained_tasks(self):
        other = self.new_task('Not included')
        apply_pull_request_event(self.payload(), 'closed')
        apply_pull_request_event(self.payload(number=2, task=other, sha='b'), 'closed')
        self.read.side_effect = lambda path, **kw: {'status': 'ahead' if 'a'*40 in path else 'diverged'}
        p = self.promotion()
        apply_pull_request_event(p, 'closed')
        self.assertEqual(self.column(), 'Done')
        self.assertEqual(self.column(other), 'In Dev')
        self.assertTrue(TaskPullRequest.objects.filter(task=self.task, pr_number=10).exists())
        self.assertFalse(TaskPullRequest.objects.filter(task=other, pr_number=10).exists())
        apply_pull_request_event(p, 'edited')
        self.assertTrue(TaskPullRequest.objects.filter(task=self.task, pr_number=10).exists())

    def test_late_feature_link_after_promotion_is_done(self):
        apply_pull_request_event(self.promotion(), 'closed')
        apply_pull_request_event(self.payload(), 'edited')
        self.assertEqual(self.column(), 'Done')
        self.read.assert_called_once_with('compare/' + 'a'*40 + '...' + 'f'*40, params={'per_page':1})

    def test_cancelled_work_stays_cancelled(self):
        self.task.column = Column.objects.create(project=self.project, name='Cancelled', kind='other', order=6)
        self.task.save()
        apply_pull_request_event(self.payload(base='main'), 'closed')
        self.assertEqual(self.column(), 'Cancelled')

    def test_failed_comparison_leaves_promotion_retryable(self):
        apply_pull_request_event(self.payload(), 'closed')
        self.read.side_effect = GitHubUnavailable()
        with self.assertRaises(GitHubUnavailable):
            apply_pull_request_event(self.promotion(), 'closed')
        self.assertFalse(PullRequestSnapshot.objects.filter(pr_number=10).exists())
        self.assertEqual(self.column(), 'In Dev')

    def test_missing_merge_sha_hydrates_legacy_links(self):
        apply_pull_request_event(self.payload(), 'closed')
        PullRequestSnapshot.objects.all().delete()
        self.read.side_effect = lambda path, **kw: self.payload()['pull_request'] if path == 'pulls/1' else {'status':'ahead'}
        apply_pull_request_event(self.promotion(), 'closed')
        self.assertEqual(self.column(), 'Done')

    def test_fork_named_dev_is_not_a_promotion(self):
        apply_pull_request_event(self.payload(), 'closed')
        p=self.promotion()
        p['pull_request']['head']['repo']['id']=123
        apply_pull_request_event(p, 'closed')
        self.assertEqual(self.column(), 'In Dev')
        self.read.assert_not_called()

    def test_compare_validation(self):
        with self.assertRaises(GitHubUnavailable):
            contains(self.read, None, 'a'*40)
        self.assertTrue(contains(self.read, 'a'*40, 'a'*40))
        self.read.assert_not_called()

    def test_same_second_conflicting_edits_read_authoritative_state(self):
        p = self.payload()
        apply_pull_request_event(p, 'closed')
        stale = self.payload()
        stale['pull_request']['title'] = 'No reference'
        @contextmanager
        def reader(repo_id):
            yield Mock(return_value=p['pull_request'])
        with patch('apps.integrations.services.repository_reader', reader):
            apply_pull_request_event(stale, 'edited')
        self.assertTrue(TaskPullRequest.objects.filter(task=self.task, pr_number=1).exists())

    def test_release_arriving_during_feature_processing_is_rechecked(self):
        from .promotions import resolve_promotion
        injected = False
        def resolve(repo_id, pr):
            nonlocal injected
            result = resolve_promotion(repo_id, pr)
            if pr['number'] == 1 and not injected:
                injected = True
                apply_pull_request_event(self.promotion(), 'closed')
            return result
        with patch('apps.integrations.services.resolve_promotion', resolve):
            apply_pull_request_event(self.payload(), 'closed')
        self.assertEqual(self.column(), 'Done')

    def test_feature_arriving_during_release_processing_is_rechecked(self):
        from .promotions import resolve_promotion
        injected = False
        def resolve(repo_id, pr):
            nonlocal injected
            result = resolve_promotion(repo_id, pr)
            if pr['number'] == 10 and not injected:
                injected = True
                apply_pull_request_event(self.payload(), 'closed')
            return result
        with patch('apps.integrations.services.resolve_promotion', resolve):
            apply_pull_request_event(self.promotion(), 'closed')
        self.assertEqual(self.column(), 'Done')

    def test_legacy_merged_cache_cannot_be_reset_by_first_stale_webhook(self):
        p = self.payload()
        apply_pull_request_event(p, 'closed')
        PullRequestSnapshot.objects.all().delete()
        @contextmanager
        def reader(repo_id):
            yield Mock(return_value=p['pull_request'])
        with patch('apps.integrations.services.repository_reader', reader):
            apply_pull_request_event(self.payload(merged=False), 'opened')
        self.assertTrue(TaskPullRequest.objects.get(task=self.task).merged)
        self.assertEqual(self.column(), 'In Dev')

    def test_review_request_does_not_choose_in_dev_even_if_ordered_first(self):
        self.project.columns.filter(name='In Review').update(order=10)
        apply_pull_request_event(self.payload(merged=False), 'review_requested')
        self.assertEqual(self.column(), 'In Review')
