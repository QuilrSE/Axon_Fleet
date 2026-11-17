// A2A ⇄ DealerFlow adapter. The only file in Agent B that knows about A2A message shapes.
import { readEnvelope, dataPart, agentMessage, newId, validateTelemetry } from '@axon-fleet/shared';

/** A2A message/send → DealerFlow WorkOrder */
export function toWorkOrder(rpc, inbound) {
  const env = readEnvelope(rpc);
  const data = dataPart(rpc.params.message) ?? {};
  const payload = data.payload ?? env.payload ?? {};
  return {
    workOrderId: env.task_id,
    contextId: rpc.params.message.contextId ?? env.correlation_id,
    requester: env.sender_agent_id,
    verifiedRequester: inbound.verifiedCaller,
    via: inbound.via,
    gatewayName: inbound.gateway?.name ?? null,
    vehicle: payload.vehicle ?? {},
    telemetry: payload.telemetry,
    detectedIssues: payload.detectedIssues ?? [],
    preferences: payload.preferences ?? {},
    pushConfig: rpc.params.configuration?.pushNotificationConfig ?? null,
    envelope: env,
  };
}

export function validateWorkOrder(wo) {
  const errors = [];
  if (!wo.vehicle?.vehicleId) errors.push('payload.vehicle.vehicleId is required');
  errors.push(...validateTelemetry(wo.telemetry).map((e) => `payload.telemetry: ${e}`));
  return errors;
}

/** DealerFlow transition → A2A TaskStatus.message */
export const toStatusMessage = (stage, summary) => agentMessage(summary.text, { stage, ...(summary.data ?? {}) });

/** DealerFlow final state → A2A Artifact */
export function toArtifact(assessment) {
  return {
    artifactId: newId('art'),
    name: 'service-assessment',
    description: 'Service assessment, parts reservation/order status and proposed appointment',
    parts: [{ kind: 'data', data: assessment }],
  };
}
