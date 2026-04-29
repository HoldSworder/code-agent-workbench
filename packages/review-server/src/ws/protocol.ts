import type { Role } from '../db/repositories/assessment.repo'

export type ParticipantRole = Role | 'host'

export interface UserIdentity {
  userId: string
  userName: string
  role: ParticipantRole
}

export interface ClarificationDto {
  id: string
  sessionId: string
  userId: string
  userName: string
  content: string
  parentId: string | null
  createdAt: string
}

export interface AssessmentResultDto {
  role: Role
  points: number
  rationale: string
}

export type ClientMessage =
  | { type: 'auth', larkUserId: string, larkUserName: string, role: ParticipantRole }
  | { type: 'join', sessionId: string }
  | { type: 'leave', sessionId: string }
  | { type: 'spec.patch', sessionId: string, baseVersion: number, content: string }
  | { type: 'clarify.add', sessionId: string, content: string, parentId?: string }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'session.snapshot', session: SessionDto, spec: string, specVersion: number, clarifications: ClarificationDto[], participants: UserIdentity[] }
  | { type: 'spec.updated', sessionId: string, version: number, content: string, by: { userId: string, userName: string } }
  | { type: 'spec.conflict', sessionId: string, currentVersion: number, content: string }
  | { type: 'clarify.added', sessionId: string, clarification: ClarificationDto }
  | { type: 'participant.joined' | 'participant.left', sessionId: string, user: UserIdentity }
  | { type: 'assessment.completed', sessionId: string, results: AssessmentResultDto[] }
  | { type: 'session.confirmed', sessionId: string }
  | { type: 'error', code: string, message: string }
  | { type: 'pong' }

export interface SessionDto {
  id: string
  requirementId: string
  requirementTitle: string
  feishuRequirementUrl: string | null
  feishuSpecDocToken: string | null
  feishuSpecDocUrl: string | null
  relatedRepos: string[]
  status: 'open' | 'confirmed' | 'closed'
  hostUserId: string
  hostUserName: string
  createdAt: string
}
