import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { modelConnections } from '../../database/model-connections.schema';
import { AGENT_TEMPLATE_IDS } from '../../../shared/agent-roster.interface';
import { TEAM_TEMPLATES } from '../../../shared/team-templates';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { makeTeamFixture } from './team-test.fixture';

test('fixed templates pin owner-local protected prototypes and preserve custom friends and version history', {
    skip: !process.env.TEAM_TEST_DATABASE_URL,
}, async () => {
    const f = await makeTeamFixture();
    try {
        const roster = new AgentRosterService(f.db);
        const template = TEAM_TEMPLATES[0];
        const specialty = template.staffing[0].recommendedTemplateId;
        const custom = await roster.create(f.owner, {
            requestKey: randomUUID(), templateId: specialty,
            executor: { executionMode: 'model', connectionId: f.connection.id, model: 'slow' },
        });
        const edited = await roster.update(f.owner, custom.id, {
            requestKey: randomUUID(), expectedRevision: custom.revision, instructions: 'Custom capability v2',
        });
        const request = { requestKey: randomUUID(), name: 'Fixed first', templateId: template.id };
        const [first, second, directory] = await Promise.all([
            f.service.create(f.owner, request),
            f.service.create(f.owner, { ...request, requestKey: randomUUID(), name: 'Fixed second' }),
            roster.list(f.owner),
        ]);
        const prototypes = directory.items.filter(item => item.origin === 'builtin');
        assert.deepEqual(prototypes.map(item => item.currentVersion.config.templateId).sort(), [...AGENT_TEMPLATE_IDS].sort());
        assert.equal(directory.items.find(item => item.id === custom.id)?.currentVersionId, edited.currentVersionId);
        assert.deepEqual(await roster.version(f.owner, custom.id, custom.currentVersionId), custom.currentVersion);
        assert.deepEqual(await f.service.create(f.owner, request), first);
        for (const slot of template.staffing) {
            const label = template.display.roleLabels[slot.roleId];
            const friend = prototypes.find(item => item.currentVersion.config.templateId === slot.recommendedTemplateId)!;
            for (const team of [first, second]) {
                const role = team.draft.config.roles.find(item => team.display.roleLabels[item.id] === label)!;
                assert.equal(role.agentId, friend.id);
                assert.equal(role.agentVersionId, friend.currentVersionId);
                assert.equal(role.executor, null);
                assert.equal(role.participation, 'placeholder');
                assert.deepEqual(role.sourceGrantIds, []);
                assert.deepEqual(role.allowedToolIds, []);
            }
        }
        const friend = prototypes[0];
        const stranger = await roster.list(f.stranger);
        assert.ok(stranger.items.every(item => item.origin === 'builtin' && !directory.items.some(owned => owned.id === item.id)));
        await assert.rejects(roster.detail(f.stranger, friend.id), /could not be found/);
        const isReadOnly = (error: unknown) => typeof error === 'object' && error !== null && 'getResponse' in error
            && typeof error.getResponse === 'function' && error.getResponse().code === 'AGENT_BUILTIN_READ_ONLY';
        await assert.rejects(roster.update(f.owner, friend.id, {
            requestKey: randomUUID(), expectedRevision: friend.revision, instructions: 'Overwrite prototype',
        }), isReadOnly);
        await assert.rejects(roster.archive(f.owner, friend.id, {
            requestKey: randomUUID(), expectedRevision: friend.revision,
        }), isReadOnly);
        assert.deepEqual(await roster.detail(f.owner, friend.id), friend);
        assert.equal((await roster.history(f.owner, friend.id)).items.length, 1);

        await f.db.update(modelConnections).set({ testState: 'passed' }).where(eq(modelConnections.id, f.connection.id));
        const selection = [{ agentId: friend.id, agentVersionId: friend.currentVersionId }];
        const available = await roster.detail(f.owner, friend.id);
        assert.equal(available.availability, 'configured');
        assert.deepEqual(available.effectiveExecutor, { executionMode: 'model', connectionId: f.connection.id, model: 'slow' });
        const [member] = await roster.resolveMembers(f.owner, selection);
        assert.equal(member.connectionId, f.connection.id);
        assert.equal(member.rosterAgentVersionId, friend.currentVersionId);

        await f.db.insert(modelConnections).values({
            owner: f.owner, name: 'Another tested connection', baseUrl: 'https://another.invalid',
            fastModel: 'another-fast', slowModel: 'another-slow', apiKeyEnc: 'fixture', testState: 'passed',
        });
        const ambiguous = await roster.detail(f.owner, friend.id);
        assert.equal(ambiguous.availability, 'unavailable');
        assert.equal(ambiguous.effectiveExecutor, undefined);
        await assert.rejects(roster.resolveMembers(f.owner, selection), /unambiguous usable connection/);
        assert.equal((await roster.resolveMembers(f.owner, [{ agentId: custom.id, agentVersionId: edited.currentVersionId }]))[0].connectionId,
            f.connection.id);
        assert.deepEqual(await roster.version(f.owner, friend.id, friend.currentVersionId), friend.currentVersion);
    } finally {
        await f.dispose();
    }
});
