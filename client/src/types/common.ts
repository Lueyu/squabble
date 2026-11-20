/**
 * @file types/common.ts
 * @description 共享的应用级 TypeScript 类型。
 *
 * 存放通用领域形状（用户资料、文件附件），并配合全局声明扩充 `Window`
 * 接口的运行时注入字段。组合记录（持仓/订单等）通常直接从
 * `api/index.ts` 的 API 响应里推断类型，而不是在这里重复声明。
 *
 * 职责边界：
 *  - 只放跨页面共享的通用类型；页面私有类型留在各自文件
 * 上下游：
 *  - 上游（谁调用这里）：经 types/index.ts barrel 供客户端引用
 *  - 下游（本文件调用谁）：无（纯类型声明）
 */
/**
 * 用户账号的生命周期状态。
 */
enum IUserStatus {
  /** 账号活跃，可正常登录。 */
  active = 1,
  /** 账号已停用。 */
  inactive = 2,
}

/**
 * 当前已登录用户的资料元数据。
 */
export type IUserProfile = {
  /** 用户主键 id。 */
  user_id: string;
  /** 登录邮箱。 */
  email: string;
  /** 展示名。 */
  name: string;
  /** 头像图片 URL。 */
  avatar: string;
  /** 账号生命周期状态。 */
  status: IUserStatus;
};

/**
 * 对象存储桶中一个文件的引用。
 */
export type IFileAttachment = {
  /** 文件所在的桶。 */
  bucket_id: string;
  /** 桶内的文件路径/键。 */
  file_path: string;
};
