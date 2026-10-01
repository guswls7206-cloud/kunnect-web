"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { WithdrawSection } from "@/components/account/withdraw-section";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Field, inputClass } from "@/components/ui/field";
import { Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import {
  passwordChangeSchema as passwordSchema,
  type PasswordChangeValues as PasswordValues,
} from "@/features/auth/schemas";
import { useLogout } from "@/features/auth/use-logout";
import { meKey, useMe } from "@/features/auth/use-me";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Me, MeSettings } from "@/lib/api/types";

const TOGGLES: Array<{ key: keyof MeSettings; label: string }> = [
  { key: "notifyMatch", label: "매칭 알림" },
  { key: "notifyComment", label: "댓글·답글 알림" },
  { key: "notifyMessage", label: "쪽지 알림" },
];

function NotificationSettings({ settings }: { settings: MeSettings }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  // 스위치는 누르는 즉시 바뀌어 보이도록 로컬 상태를 먼저 갱신하고, 서버 저장에 실패하면 되돌린다.
  const [local, setLocal] = useState(settings);
  const update = useMutation({
    mutationFn: (patch: Partial<MeSettings>) => api.settings.update(patch),
    onSuccess: (saved) => {
      queryClient.setQueryData<Me | null>(meKey, (prev) =>
        prev ? { ...prev, settings: saved } : prev,
      );
    },
    onError: (_error, patch) => {
      setLocal((prev) => ({
        ...prev,
        ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, !v])),
      }));
      toast.show("설정을 저장하지 못했습니다.", "error");
    },
  });
  return (
    <section aria-labelledby="noti-settings" className="card p-5">
      <h2 id="noti-settings" className="text-base font-bold text-slate-900">
        알림 설정
      </h2>
      <ul className="mt-2 divide-y divide-slate-100">
        {TOGGLES.map(({ key, label }) => (
          <li key={key} className="flex min-h-12 items-center justify-between">
            <label htmlFor={`s-${key}`} className="text-sm text-slate-700">
              {label}
            </label>
            <input
              id={`s-${key}`}
              type="checkbox"
              role="switch"
              checked={local[key]}
              onChange={(e) => {
                setLocal((prev) => ({ ...prev, [key]: e.target.checked }));
                update.mutate({ [key]: e.target.checked });
              }}
              className="size-5 accent-brand-600"
            />
          </li>
        ))}
      </ul>
      <p className="mt-3 rounded-lg bg-slate-100/80 px-3 py-2 text-xs leading-relaxed text-slate-600">
        Web Push 알림은 데모에서 제공하지 않아요. 알림은 앱 안의 알림 센터에서 확인해요.
      </p>
    </section>
  );
}

function BlockList() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const blocks = useQuery({
    queryKey: ["blocks"],
    queryFn: async () => (await api.blocks.list()).items,
  });
  const unblock = useMutation({
    mutationFn: (userId: number) => api.blocks.remove(userId),
    onSuccess: () => {
      toast.show("차단을 해제했어요.");
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: () => toast.show("처리하지 못했습니다.", "error"),
  });
  return (
    <section aria-labelledby="block-list" className="card p-5">
      <h2 id="block-list" className="text-base font-bold text-slate-900">
        차단 목록
      </h2>
      {blocks.isPending ? (
        <Spinner />
      ) : blocks.isError ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          차단 목록을 불러오지 못했습니다.
        </p>
      ) : blocks.data.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">차단한 사용자가 없어요.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {blocks.data.map((b) => (
            <li key={b.userId} className="flex min-h-12 items-center justify-between">
              <span className="text-sm text-slate-700">{b.nickname}</span>
              <Button
                variant="secondary"
                loading={unblock.isPending && unblock.variables === b.userId}
                onClick={() => unblock.mutate(b.userId)}
              >
                해제
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PasswordForm() {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.settings.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      toast.show("비밀번호를 변경했어요.");
      reset();
    } catch (error) {
      if (isApiError(error, 403)) return setError("currentPassword", { message: error.message });
      if (isApiError(error) && error.fields?.newPassword)
        return setError("newPassword", { message: error.fields.newPassword });
      setFormError(isApiError(error) ? error.message : "변경하지 못했습니다.");
    }
  });

  return (
    <section aria-labelledby="pw-settings" className="card p-5">
      <h2 id="pw-settings" className="text-base font-bold text-slate-900">
        비밀번호 변경
      </h2>
      <form onSubmit={onSubmit} noValidate className="mt-3 flex flex-col gap-3">
        <Field label="현재 비밀번호" error={errors.currentPassword?.message} required>
          {(p) => (
            <input
              {...p}
              {...register("currentPassword")}
              type="password"
              autoComplete="current-password"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="새 비밀번호" hint="8~64자" error={errors.newPassword?.message} required>
          {(p) => (
            <input
              {...p}
              {...register("newPassword")}
              type="password"
              autoComplete="new-password"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="새 비밀번호 확인" error={errors.confirm?.message} required>
          {(p) => (
            <input
              {...p}
              {...register("confirm")}
              type="password"
              autoComplete="new-password"
              className={inputClass}
            />
          )}
        </Field>
        {formError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </p>
        )}
        <Button type="submit" loading={isSubmitting}>
          변경하기
        </Button>
      </form>
    </section>
  );
}

export default function SettingsPage() {
  const { data: me } = useMe();
  const { logout, loggingOut } = useLogout();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="설정" />
      {me ? <NotificationSettings settings={me.settings} /> : <Spinner />}
      <BlockList />
      <PasswordForm />
      <Button variant="secondary" loading={loggingOut} onClick={logout}>
        로그아웃
      </Button>
      <WithdrawSection />
    </div>
  );
}
