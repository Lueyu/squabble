import type { ToolCapabilityActivation, ToolCapabilityView } from '@shared/tool-capabilities.interface';

export function recommendedGrants(views: ToolCapabilityView[], choices: { publicNetwork: boolean; privateLocal: boolean }): ToolCapabilityActivation['grants'] {
  return views.filter(view => view.installation === 'ready' && view.catalog === 'verified' && view.grant === 'disabled'
    && (choices.privateLocal || view.packId !== 'documents')
    && (choices.publicNetwork || !['browser', 'market_data'].includes(view.packId))).map(view => ({
      packId: view.packId, revision: view.revision, manifestHash: view.manifestHash,
      catalogVersionId: view.catalogVersionId, schemaHash: view.schemaHash,
      dataClasses: choices.privateLocal && ['documents', 'compute'].includes(view.packId)
        ? ['public', 'private_material', 'portfolio'] : ['public'],
    }));
}
