import { getDashboardConnection } from '@/shared/api';
import { createGrpcSchemaStore } from './createGrpcSchemaStore';

/** The app's real gRPC schema store, wired to the real dashboard connection (see shared/api/dashboardConnection.ts). */
export const useGrpcSchemaStore = createGrpcSchemaStore(getDashboardConnection());
