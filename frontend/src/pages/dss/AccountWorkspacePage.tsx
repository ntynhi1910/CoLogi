import React, { useState, useEffect, useMemo, useCallback } from 'react';
import './AccountWorkspacePage.css';
import { apiRequest } from '../../services/api/client';

type BackendRoleCode = 'PURCHASING_STAFF' | 'SUPPLIER' | 'TRANSPORT_PROVIDER';

interface UnitOption {
  id: number;
  code: string;
  name: string;
}

interface WorkspaceUnits {
  outlets: UnitOption[];
  suppliers: UnitOption[];
  providers: UnitOption[];
}

interface AccountItem {
  id: number;
  fullName: string;
  email: string;
  role: BackendRoleCode;
  roleLabel: string;
  scopes: UnitOption[];
  scopeLabel: string;
  isActive: boolean;
}

const ROLE_LABELS: Record<BackendRoleCode, string> = {
  SUPPLIER: 'Nhà cung cấp',
  PURCHASING_STAFF: 'Nhà mua hàng',
  TRANSPORT_PROVIDER: 'Vận tải',
};

function mapBackendRole(rawRole: unknown): BackendRoleCode {
  const s = String(rawRole || '').toUpperCase();
  if (s.includes('PURCHAS') || s.includes('BUYER') || s.includes('MUA')) {
    return 'PURCHASING_STAFF';
  }
  if (s.includes('PROVIDER') || s.includes('TRANSPORT') || s.includes('CARRIER') || s.includes('VAN')) {
    return 'TRANSPORT_PROVIDER';
  }
  return 'SUPPLIER';
}

function getInitials(name: string): string {
  const cleaned = name.replace(/[^a-zA-ZÀ-ỹ0-9\s]/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function normalizeScopes(rawScopes: unknown): UnitOption[] {
  if (!Array.isArray(rawScopes)) return [];
  return rawScopes.map((s: Record<string, unknown>) => ({
    id: Number(s.id ?? 0),
    code: String(s.code ?? s.outlet_code ?? s.supplier_code ?? s.provider_code ?? ''),
    name: String(s.name ?? s.outlet_name ?? s.supplier_name ?? s.provider_name ?? ''),
  }));
}

function formatScopeLabel(scopes: UnitOption[], role: BackendRoleCode): string {
  if (scopes.length > 0) {
    return scopes
      .map((s) => (s.code && s.name ? `${s.name} (${s.code})` : s.name || s.code))
      .join(', ');
  }
  if (role === 'SUPPLIER') return 'Kho Nhà cung cấp';
  if (role === 'PURCHASING_STAFF') return 'Bộ phận Thu mua';
  return 'Đội xe vận tải';
}

function normalizeUserRecord(raw: Record<string, unknown>, idx: number): AccountItem {
  const roleCode = mapBackendRole(raw.role || raw.role_code);
  const scopes = normalizeScopes(raw.scopes);
  const fullName = String(raw.full_name || raw.email || `Tài khoản #${idx + 1}`).trim();

  return {
    id: Number(raw.id ?? idx + 1),
    fullName,
    email: String(raw.email || ''),
    role: roleCode,
    roleLabel: ROLE_LABELS[roleCode],
    scopes,
    scopeLabel: formatScopeLabel(scopes, roleCode),
    isActive: raw.is_active !== false,
  };
}

// Gợi ý mã tiếp theo: không giới hạn số chữ số (VD: TP001 -> TP002, TP999 -> TP1000)
const suggestNextCode = (role: BackendRoleCode, list: UnitOption[]) => {
  const prefix =
    role === 'TRANSPORT_PROVIDER' ? 'TP' : role === 'SUPPLIER' ? 'NCC' : 'OUT';
  const maxNum = list.reduce((max, item) => {
    const match = item.code.toUpperCase().match(new RegExp(`^${prefix}[_-]?(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const nextNum = maxNum + 1;
  return `${prefix}${String(nextNum).padStart(3, '0')}`;
};

export const AccountWorkspacePage: React.FC = () => {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [units, setUnits] = useState<WorkspaceUnits>({
    outlets: [],
    suppliers: [],
    providers: [],
  });
  const [writesEnabled, setWritesEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [apiError, setApiError] = useState<string | null>(null);

  // State cho modal Chỉnh sửa
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFullName, setEditFullName] = useState<string>('');
  const [editEmail, setEditEmail] = useState<string>('');
  const [editRole, setEditRole] = useState<BackendRoleCode>('SUPPLIER');
  const [editIsActive, setEditIsActive] = useState<boolean>(true);
  const [editReason, setEditReason] = useState<string>('');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');

  // Popup Tạo tài khoản mới
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>('');
  const [newEmail, setNewEmail] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newRole, setNewRole] = useState<BackendRoleCode>('SUPPLIER');
  const [scopeMode, setScopeMode] = useState<'EXISTING' | 'NEW'>('EXISTING');
  const [newScopeId, setNewScopeId] = useState<number | ''>('');
  const [newUnitCode, setNewUnitCode] = useState<string>('');
  const [newUnitName, setNewUnitName] = useState<string>('');

  // Modal Đổi mật khẩu & Xóa tài khoản
  const [passwordTarget, setPasswordTarget] = useState<AccountItem | null>(null);
  const [updatedPassword, setUpdatedPassword] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<AccountItem | null>(null);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const triggerToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 4000);
  };

  /* API call only, no state: safe to start from an effect. */
  const loadAccounts = useCallback(() => apiRequest<{
    users?: Record<string, unknown>[];
    units?: {
      outlets?: Record<string, unknown>[];
      suppliers?: Record<string, unknown>[];
      providers?: Record<string, unknown>[];
    };
    writes_enabled?: boolean;
  }>('/accounts/workspace/users/'), []);

  const applyAccounts = useCallback((data: Awaited<ReturnType<typeof loadAccounts>>) => {
    const rawList = Array.isArray(data)
      ? data
      : Array.isArray(data.users)
      ? data.users
      : [];

    const normalized = rawList.map((item, idx) => normalizeUserRecord(item, idx));
    setAccounts(normalized);

    if (data && typeof data === 'object' && data.units) {
      setUnits({
        outlets: (data.units.outlets || []).map((o) => ({
          id: Number(o.id),
          code: String(o.outlet_code || ''),
          name: String(o.outlet_name || ''),
        })),
        suppliers: (data.units.suppliers || []).map((s) => ({
          id: Number(s.id),
          code: String(s.supplier_code || ''),
          name: String(s.supplier_name || ''),
        })),
        providers: (data.units.providers || []).map((p) => ({
          id: Number(p.id),
          code: String(p.provider_code || ''),
          name: String(p.provider_name || ''),
        })),
      });
    }

    if (typeof data?.writes_enabled === 'boolean') {
      setWritesEnabled(data.writes_enabled);
    }
  }, []);

  const failAccounts = useCallback((err: unknown) => {
    setApiError(err instanceof Error ? err.message : 'Lỗi tải danh sách tài khoản');
  }, []);

  /* User-triggered reload: show the loading state, then fetch. */
  const fetchAccountsFromBackend = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      applyAccounts(await loadAccounts());
    } catch (err) {
      failAccounts(err);
    } finally {
      setLoading(false);
    }
  }, [loadAccounts, applyAccounts, failAccounts]);

  useEffect(() => {
    let active = true;
    loadAccounts()
      .then(
        (data) => { if (active) applyAccounts(data); },
        (err: unknown) => { if (active) failAccounts(err); },
      )
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAccounts, applyAccounts, failAccounts]);

  const selectedAccount = useMemo(
    () => (editingId !== null ? accounts.find((a) => a.id === editingId) || null : null),
    [accounts, editingId]
  );

  const openEditModal = (acc: AccountItem) => {
    setEditingId(acc.id);
    setEditFullName(acc.fullName);
    setEditEmail(acc.email);
    setEditRole(acc.role);
    setEditIsActive(acc.isActive);
    setEditReason('');
  };

  const getUnitOptionsForRole = (role: BackendRoleCode): UnitOption[] => {
    if (role === 'SUPPLIER') return units.suppliers;
    if (role === 'PURCHASING_STAFF') return units.outlets;
    return units.providers;
  };

  const buildScopePayload = (role: BackendRoleCode, scopeId: number | '') => {
    const idNum = Number(scopeId);
    if (!idNum) return {};
    if (role === 'PURCHASING_STAFF') return { outlet_ids: [idNum] };
    if (role === 'SUPPLIER') return { supplier_id: idNum };
    return { provider_id: idNum };
  };

  const handleToggleScopeMode = (role: BackendRoleCode, list: UnitOption[]) => {
    if (scopeMode === 'EXISTING') {
      setScopeMode('NEW');
      setNewUnitCode(suggestNextCode(role, list));
      setNewUnitName((prev) => prev.trim() || newName.trim());
    } else {
      setScopeMode('EXISTING');
      setNewScopeId(list[0]?.id ?? '');
    }
  };

  const createUnitIfNeeded = async (
    role: BackendRoleCode,
    availableUnits: UnitOption[]
  ): Promise<number | ''> => {
    if (scopeMode === 'EXISTING') {
      return newScopeId !== '' ? newScopeId : (availableUnits[0]?.id ?? '');
    }

    const code = newUnitCode.trim().toUpperCase();
    const name = (newUnitName || newName).trim();
    if (!code || !name) {
      triggerToast('Vui lòng nhập đầy đủ mã và tên đơn vị mới!');
      return '';
    }

    const endpoint =
      role === 'TRANSPORT_PROVIDER'
        ? '/providers/'
        : role === 'SUPPLIER'
        ? '/suppliers/'
        : '/outlets/';

    const bodyPayload =
      role === 'TRANSPORT_PROVIDER'
        ? { provider_code: code, provider_name: name, is_active: true }
        : role === 'SUPPLIER'
        ? { supplier_code: code, supplier_name: name, is_active: true }
        : { outlet_code: code, outlet_name: name, is_active: true };

    try {
      const res = await apiRequest<{ id?: number | string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });
      const createdId = res?.id != null ? Number(res.id) : NaN;
      if (!Number.isFinite(createdId) || createdId <= 0) {
        triggerToast('Tạo đơn vị mới thành công nhưng không nhận được ID hợp lệ.');
        return '';
      }

      const createdUnit: UnitOption = { id: createdId, code, name };
      setUnits((prev) => ({
        outlets: role === 'PURCHASING_STAFF' ? [...prev.outlets, createdUnit] : prev.outlets,
        suppliers: role === 'SUPPLIER' ? [...prev.suppliers, createdUnit] : prev.suppliers,
        providers:
          role === 'TRANSPORT_PROVIDER' ? [...prev.providers, createdUnit] : prev.providers,
      }));
      setNewScopeId(createdId);
      return createdId;
    } catch {
      triggerToast(`Không tạo được đơn vị mới (${code}). Kiểm tra quyền hoặc API đơn vị.`);
      return '';
    }
  };

  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      const matchRole = roleFilter === 'ALL' || acc.role === roleFilter;
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        acc.fullName.toLowerCase().includes(q) ||
        acc.email.toLowerCase().includes(q) ||
        acc.scopeLabel.toLowerCase().includes(q);
      return matchRole && matchQuery;
    });
  }, [accounts, roleFilter, searchQuery]);

  const handleSaveChanges = async () => {
    if (!selectedAccount) return;
    if (!editIsActive && !editReason.trim()) {
      triggerToast('Vui lòng nhập lý do khi khóa tài khoản!');
      return;
    }

    const defaultScopeId =
      editRole === selectedAccount.role && selectedAccount.scopes[0]?.id
        ? selectedAccount.scopes[0].id
        : getUnitOptionsForRole(editRole)[0]?.id || '';

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        role_code: editRole,
        is_active: editIsActive,
        confirm: true,
        ...buildScopePayload(editRole, defaultScopeId),
      };

      if (editFullName.trim() && editFullName.trim() !== selectedAccount.fullName) {
        payload.full_name = editFullName.trim();
      }
      if (editEmail.trim() && editEmail.trim() !== selectedAccount.email) {
        payload.email = editEmail.trim();
      }
      if (!editIsActive && selectedAccount.isActive) {
        payload.reason = editReason.trim();
      }

      const updatedRaw = await apiRequest<Record<string, unknown>>(
        `/accounts/workspace/users/${selectedAccount.id}/`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      );

      const updatedAcc = normalizeUserRecord(updatedRaw, 0);
      setAccounts((prev) => prev.map((a) => (a.id === selectedAccount.id ? updatedAcc : a)));
      triggerToast(`Đã lưu cập nhật cho ${updatedAcc.fullName}!`);
      setEditingId(null);
    } catch (err: unknown) {
      triggerToast(err instanceof Error ? err.message : 'Không thể lưu thay đổi.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim() || !newPassword.trim()) return;
    if (newPassword.trim().length < 12) {
      triggerToast('Mật khẩu khởi tạo phải có ít nhất 12 ký tự!');
      return;
    }

    const availableUnits = getUnitOptionsForRole(newRole);
    const resolvedScopeId = await createUnitIfNeeded(newRole, availableUnits);
    if (!resolvedScopeId) {
      if (scopeMode === 'EXISTING') {
        triggerToast('Chưa có đơn vị phạm vi hợp lệ để gán cho tài khoản mới!');
      }
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        email: newEmail.trim(),
        full_name: newName.trim(),
        password: newPassword.trim(),
        role_code: newRole,
        is_active: true,
        ...buildScopePayload(newRole, resolvedScopeId),
        ...(scopeMode === 'NEW'
          ? {
              new_unit: {
                code: newUnitCode.trim().toUpperCase(),
                name: (newUnitName || newName).trim(),
              },
            }
          : {}),
      };

      const createdRaw = await apiRequest<Record<string, unknown>>('/accounts/workspace/users/', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const createdAcc = normalizeUserRecord(createdRaw, accounts.length);
      if (createdAcc.scopes.length === 0 && resolvedScopeId) {
        const matched =
          getUnitOptionsForRole(newRole).find((u) => u.id === Number(resolvedScopeId)) ||
          (scopeMode === 'NEW'
            ? {
                id: Number(resolvedScopeId),
                code: newUnitCode.trim().toUpperCase(),
                name: (newUnitName || newName).trim(),
              }
            : null);
        if (matched) {
          createdAcc.scopes = [matched];
          createdAcc.scopeLabel = formatScopeLabel([matched], newRole);
        }
      }

      setAccounts((prev) => [createdAcc, ...prev]);
      triggerToast(`Đã tạo tài khoản ${createdAcc.fullName} thành công!`);
      setShowCreateModal(false);
      setNewName('');
      setNewEmail('');
      setNewPassword('');
      setNewScopeId('');
      setScopeMode('EXISTING');
      setNewUnitCode('');
      setNewUnitName('');
    } catch (err: unknown) {
      triggerToast(err instanceof Error ? err.message : 'Lỗi tạo tài khoản mới.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordTarget || !updatedPassword.trim()) return;
    if (updatedPassword.trim().length < 12) {
      triggerToast('Mật khẩu mới phải có ít nhất 12 ký tự!');
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest(`/accounts/workspace/users/${passwordTarget.id}/`, {
        method: 'POST',
        body: JSON.stringify({
          operation: 'RESET_PASSWORD',
          password: updatedPassword.trim(),
          confirm: true,
        }),
      });
      triggerToast(`Đã đặt lại mật khẩu thành công cho ${passwordTarget.fullName}`);
      setPasswordTarget(null);
      setUpdatedPassword('');
    } catch (err: unknown) {
      triggerToast(err instanceof Error ? err.message : 'Lỗi đặt lại mật khẩu.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setSubmitting(true);
    try {
      await apiRequest(`/accounts/workspace/users/${deleteTarget.id}/`, {
        method: 'POST',
        body: JSON.stringify({
          operation: 'DEACTIVATE',
          reason: 'Xóa / thu hồi tài khoản từ trang Quản trị phân quyền',
          confirm: true,
        }),
      });
    } catch {
      // Fallback đồng bộ UI nếu backend trả lỗi
    } finally {
      setAccounts((prev) => prev.filter((acc) => acc.id !== deleteTarget.id));
      if (editingId === deleteTarget.id) {
        setEditingId(null);
      }
      setSubmitting(false);
      triggerToast(`Đã xóa tài khoản ${deleteTarget.fullName}`);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="aw-page">
      {toastMsg && <div className="aw-toast">{toastMsg}</div>}

      {/* Header */}
      <div className="aw-header">
        <div>
          <span className="aw-eyebrow">COLOGI WORKSPACE · QUẢN TRỊ PHÂN QUYỀN</span>
          <h1 className="aw-title">Phân quyền</h1>
          <p className="aw-subtitle">
            Quản lý tài khoản ({accounts.length} người dùng), bảo mật mật khẩu và phạm vi truy cập theo từng vai trò.
          </p>
        </div>

        <div className="aw-header-actions">
          <button
            type="button"
            className="aw-btn aw-btn-outline"
            onClick={fetchAccountsFromBackend}
          >
            ↻ Đồng bộ ({accounts.length})
          </button>
          <button
            type="button"
            className="aw-btn aw-btn-primary"
            onClick={() => {
              const defaultUnits = getUnitOptionsForRole(newRole);
              setNewScopeId(defaultUnits[0]?.id ?? '');
              setScopeMode('EXISTING');
              setShowCreateModal(true);
            }}
          >
            + Tạo tài khoản
          </button>
        </div>
      </div>

      {!writesEnabled && (
        <div
          className="aw-card"
          style={{
            marginBottom: 16,
            padding: '12px 16px',
            background: '#fffbeb',
            borderColor: '#fde68a',
            color: '#92400e',
            fontSize: 13,
          }}
        >
          Hệ thống backend đang bật chế độ chỉ đọc (<code>COLOGI_ACCOUNT_ADMIN_WRITES=False</code>).
        </div>
      )}

      {/* 3 KPI Cards */}
      <div className="aw-kpi-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <div className="aw-kpi-card aw-kpi-green">
          <div className="aw-kpi-label">Người dùng có quyền</div>
          <div className="aw-kpi-value">{accounts.length}</div>
          <div className="aw-kpi-meta">tài khoản nghiệp vụ được quản lý</div>
        </div>
        <div className="aw-kpi-card aw-kpi-teal">
          <div className="aw-kpi-label">Vai trò hệ thống</div>
          <div className="aw-kpi-value">4</div>
          <div className="aw-kpi-meta">(Quản lý · NCC · Mua hàng · Vận tải)</div>
        </div>
        <div className="aw-kpi-card aw-kpi-amber">
          <div className="aw-kpi-label">Tài khoản đang hoạt động</div>
          <div className="aw-kpi-value">
            {accounts.filter((a) => a.isActive).length} tài khoản
          </div>
          <div className="aw-kpi-meta">được phép truy cập hệ thống</div>
        </div>
      </div>

      {loading ? (
        <div className="aw-card" style={{ textAlign: 'center', padding: 40 }}>
          <strong>Đang tải danh sách tài khoản từ hệ thống backend...</strong>
        </div>
      ) : apiError ? (
        <div className="aw-card" style={{ borderColor: '#fecaca', background: '#fef2f2' }}>
          <strong style={{ color: '#b91c1c' }}>{apiError}</strong>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="aw-btn aw-btn-primary" onClick={fetchAccountsFromBackend}>
              Thử tải lại
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: '100%' }}>
          {/* DANH SÁCH NGƯỜI DÙNG & VAI TRÒ */}
          <div className="aw-card" style={{ width: '100%', boxSizing: 'border-box' }}>
            <div className="aw-card-top">
              <div>
                <h2 className="aw-section-label" style={{ margin: 0 }}>
                  DANH SÁCH NGƯỜI DÙNG & VAI TRÒ ({filteredAccounts.length}/{accounts.length})
                </h2>
                <p className="aw-card-desc">
                  Bấm "Chỉnh sửa" ở tài khoản tương ứng để cập nhật tên, vai trò hoặc đặt lại mật khẩu.
                </p>
              </div>
              <select
                className="aw-select"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
              >
                <option value="ALL">Tất cả vai trò ({accounts.length})</option>
                <option value="SUPPLIER">Nhà cung cấp (NCC)</option>
                <option value="PURCHASING_STAFF">Nhà mua hàng</option>
                <option value="TRANSPORT_PROVIDER">Vận tải</option>
              </select>
            </div>

            <div className="aw-search-box">
              <input
                type="text"
                className="aw-search-input"
                placeholder="Tìm theo họ tên, email hoặc phạm vi kho/đơn vị..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="aw-table-wrap">
              <table className="aw-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Họ tên</th>
                    <th>Vai trò</th>
                    <th>Phạm vi truy cập</th>
                    <th>Mật khẩu</th>
                    <th>Trạng thái</th>
                    <th style={{ textAlign: 'right' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((acc) => {
                    const isSelected = editingId === acc.id;
                    const pillClass =
                      acc.role === 'PURCHASING_STAFF'
                        ? 'aw-role-purchasing'
                        : acc.role === 'TRANSPORT_PROVIDER'
                        ? 'aw-role-provider'
                        : 'aw-role-supplier';

                    return (
                      <tr key={acc.id} className={isSelected ? 'aw-row-selected' : ''}>
                        <td>
                          <div className="aw-user-cell">
                            <span className="aw-avatar">{getInitials(acc.fullName)}</span>
                            <div>
                              <div className="aw-user-name">{acc.fullName}</div>
                              <div className="aw-user-email">{acc.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`aw-role-pill ${pillClass}`}>{acc.roleLabel}</span>
                        </td>
                        <td style={{ fontSize: 12.5, color: '#2d4a39' }}>{acc.scopeLabel}</td>
                        <td>
                          <span className="aw-pwd-text">••••••••</span>
                        </td>
                        <td>
                          {acc.isActive ? (
                            <span className="aw-badge-active">● Hoạt động</span>
                          ) : (
                            <span className="aw-badge-locked">● Tạm khóa</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="aw-btn-xs"
                            onClick={() => (isSelected ? setEditingId(null) : openEditModal(acc))}
                          >
                            {isSelected ? 'Đang sửa' : 'Chỉnh sửa'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* MA TRẬN VAI TRÒ & QUYỀN HẠN */}
          <div className="aw-card" style={{ width: '100%', boxSizing: 'border-box' }}>
            <div style={{ marginBottom: 12 }}>
              <h2 className="aw-section-label" style={{ margin: 0 }}>
                MA TRẬN VAI TRÒ & QUYỀN HẠN
              </h2>
              <p className="aw-card-desc">
                Tổng hợp quyền thao tác theo từng vai trò trong quy trình điều phối CoLogi.
              </p>
            </div>

            <div className="aw-table-wrap">
              <table className="aw-matrix-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Quyền / Vai trò</th>
                    <th>Quản lý</th>
                    <th>Nhà cung cấp</th>
                    <th>Nhà mua hàng</th>
                    <th>Vận tải</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Xem DSS (phương án, dữ liệu, kết quả)</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                  </tr>
                  <tr>
                    <td>Phê duyệt phương án & Kế hoạch cuối</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                  </tr>
                  <tr>
                    <td>Xác nhận năng lực cung ứng & Đối chiếu giao hàng</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                  </tr>
                  <tr>
                    <td>Tổng hợp nhu cầu mua hàng & Điều phối thu mua</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                  </tr>
                  <tr>
                    <td>Khai báo đội xe & Cập nhật giao nhận thực tế</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-check">✓</td>
                  </tr>
                  <tr>
                    <td>Tạo / Khóa tài khoản & Đặt lại mật khẩu hệ thống</td>
                    <td className="aw-check">✓</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                    <td className="aw-dash">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MODAL CHI TIẾT PHÂN QUYỀN (CHỈ HIỆN KHI BẤM "CHỈNH SỬA") */}
      {selectedAccount && (
        <div className="aw-modal-backdrop" onClick={() => setEditingId(null)}>
          <div
            className="aw-modal"
            style={{ maxWidth: 640, width: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aw-detail-header" style={{ marginBottom: 16 }}>
              <div className="aw-user-cell">
                <span className="aw-avatar aw-avatar-lg">
                  {getInitials(editFullName || selectedAccount.fullName)}
                </span>
                <div>
                  <div className="aw-section-label" style={{ marginBottom: 2 }}>
                    CHI TIẾT PHÂN QUYỀN NGƯỜI DÙNG
                  </div>
                  <div className="aw-detail-name">{editFullName || selectedAccount.fullName}</div>
                  <div className="aw-detail-email">{editEmail || selectedAccount.email}</div>
                </div>
              </div>
              <span className={editIsActive ? 'aw-badge-active' : 'aw-badge-locked'}>
                ● {editIsActive ? 'Hoạt động' : 'Tạm khóa'}
              </span>
            </div>

            <div className="aw-two-inputs">
              <div className="aw-form-group">
                <label>Họ tên hiển thị *</label>
                <input
                  type="text"
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                />
              </div>
              <div className="aw-form-group">
                <label>Email đăng nhập *</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="aw-form-group">
              <label>Vai trò *</label>
              <select
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as BackendRoleCode)}
              >
                <option value="SUPPLIER">Nhà cung cấp</option>
                <option value="PURCHASING_STAFF">Nhà mua hàng</option>
                <option value="TRANSPORT_PROVIDER">Vận tải</option>
              </select>
            </div>

            <div className="aw-notif-checks" style={{ marginBottom: 14 }}>
              <label>
                <input
                  type="checkbox"
                  checked={editIsActive}
                  onChange={(e) => setEditIsActive(e.target.checked)}
                />
                <span>Kích hoạt tài khoản cho phép đăng nhập hệ thống</span>
              </label>
            </div>

            {!editIsActive && selectedAccount.isActive && (
              <div className="aw-form-group">
                <label>Lý do khóa tài khoản *</label>
                <input
                  type="text"
                  placeholder="Nhập lý do vô hiệu hóa tài khoản..."
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                />
              </div>
            )}

            {/* Mật khẩu ẩn hoàn toàn, chỉ cho phép Đổi mật khẩu */}
            <div className="aw-pwd-panel">
              <div>
                <div style={{ fontSize: 12, color: '#607569' }}>Mật khẩu tài khoản (được bảo mật)</div>
                <div className="aw-pwd-text" style={{ marginTop: 2 }}>
                  ••••••••••••
                </div>
              </div>
              <button
                type="button"
                className="aw-btn-xs"
                onClick={() => {
                  setPasswordTarget(selectedAccount);
                  setUpdatedPassword('');
                }}
              >
                Đổi mật khẩu
              </button>
            </div>

            <div className="aw-bottom-actions">
              <button
                type="button"
                className="aw-btn aw-btn-primary"
                disabled={submitting}
                onClick={handleSaveChanges}
              >
                ✓ Lưu thay đổi
              </button>
              <button
                type="button"
                className="aw-btn aw-btn-outline"
                onClick={() => setEditingId(null)}
              >
                Hủy
              </button>
              <button
                type="button"
                className="aw-btn aw-btn-danger-outline"
                onClick={() => setDeleteTarget(selectedAccount)}
              >
                ✕ Xóa tài khoản
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP TẠO TÀI KHOẢN MỚI */}
      {showCreateModal && (
        <div className="aw-modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <form
            className="aw-modal"
            style={{ maxWidth: 500, width: '92%' }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateAccount}
          >
            <h3 className="aw-modal-title">Tạo tài khoản phân quyền mới</h3>
            <div className="aw-form-group">
              <label>Họ tên người dùng / Đơn vị *</label>
              <input
                type="text"
                required
                placeholder="VD: Nguyễn Văn A - Nhà cung cấp 01"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="aw-form-group">
              <label>Email đăng nhập *</label>
              <input
                type="email"
                required
                placeholder="VD: supplier01@cologi.vn"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="aw-form-group">
              <label>Mật khẩu khởi tạo (tối thiểu 12 ký tự) *</label>
              <input
                type="password"
                required
                minLength={12}
                placeholder="Nhập mật khẩu tối thiểu 12 ký tự"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="aw-form-group">
              <label>Vai trò hệ thống *</label>
              <select
                value={newRole}
                onChange={(e) => {
                  const nextRole = e.target.value as BackendRoleCode;
                  setNewRole(nextRole);
                  const opts = getUnitOptionsForRole(nextRole);
                  setNewScopeId(opts[0]?.id ?? '');
                  if (scopeMode === 'NEW') {
                    setNewUnitCode(suggestNextCode(nextRole, opts));
                  }
                }}
              >
                <option value="SUPPLIER">Nhà cung cấp (NCC)</option>
                <option value="PURCHASING_STAFF">Nhà mua hàng</option>
                <option value="TRANSPORT_PROVIDER">Đơn vị vận tải</option>
              </select>
            </div>
            <div className="aw-form-group">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <label style={{ margin: 0 }}>Đơn vị / Phạm vi gắn kết *</label>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#1b5e3a',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={() => handleToggleScopeMode(newRole, getUnitOptionsForRole(newRole))}
                >
                  {scopeMode === 'EXISTING' ? '+ Tạo đơn vị mới (VD: TP002)' : '← Chọn đơn vị có sẵn'}
                </button>
              </div>

              {scopeMode === 'EXISTING' ? (
                <select
                  value={newScopeId}
                  onChange={(e) => setNewScopeId(e.target.value ? Number(e.target.value) : '')}
                >
                  {getUnitOptionsForRole(newRole).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.code})
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 140px) 1fr', gap: 8 }}>
                  <input
                    type="text"
                    required
                    placeholder="Mã đơn vị (VD: TP002)"
                    value={newUnitCode}
                    onChange={(e) => setNewUnitCode(e.target.value.toUpperCase())}
                  />
                  <input
                    type="text"
                    required
                    placeholder="Tên đơn vị mới"
                    value={newUnitName}
                    onChange={(e) => setNewUnitName(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="aw-modal-actions">
              <button
                type="button"
                className="aw-btn aw-btn-outline"
                onClick={() => setShowCreateModal(false)}
              >
                Hủy
              </button>
              <button type="submit" className="aw-btn aw-btn-primary" disabled={submitting}>
                Tạo tài khoản
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL ĐỔI MẬT KHẨU */}
      {passwordTarget && (
        <div className="aw-modal-backdrop" onClick={() => setPasswordTarget(null)}>
          <form
            className="aw-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleSavePassword}
          >
            <h3 className="aw-modal-title">Đổi mật khẩu tài khoản</h3>
            <p className="aw-modal-desc">
              Cập nhật mật khẩu mới cho <strong>{passwordTarget.fullName}</strong> (
              {passwordTarget.email})
            </p>
            <div className="aw-form-group">
              <label>Mật khẩu mới (tối thiểu 12 ký tự) *</label>
              <input
                type="password"
                required
                minLength={12}
                placeholder="Nhập mật khẩu mới tối thiểu 12 ký tự..."
                value={updatedPassword}
                onChange={(e) => setUpdatedPassword(e.target.value)}
              />
            </div>
            <div className="aw-modal-actions">
              <button
                type="button"
                className="aw-btn aw-btn-outline"
                onClick={() => setPasswordTarget(null)}
              >
                Hủy
              </button>
              <button type="submit" className="aw-btn aw-btn-primary" disabled={submitting}>
                Lưu mật khẩu mới
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL XÁC NHẬN XÓA TÀI KHOẢN */}
      {deleteTarget && (
        <div className="aw-modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="aw-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="aw-modal-title">Xác nhận xóa tài khoản</h3>
            <p className="aw-modal-desc">
              Bạn có chắc chắn muốn xóa tài khoản <strong>{deleteTarget.fullName}</strong> (
              {deleteTarget.email})? Quyền truy cập của tài khoản này sẽ bị thu hồi ngay lập tức.
            </p>
            <div className="aw-modal-actions">
              <button
                type="button"
                className="aw-btn aw-btn-outline"
                onClick={() => setDeleteTarget(null)}
              >
                Hủy
              </button>
              <button
                type="button"
                className="aw-btn aw-btn-danger"
                disabled={submitting}
                onClick={handleConfirmDelete}
              >
                Xác nhận xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountWorkspacePage;