# DelegatedWindow 来源约定

此服务管理主体授权资料、协作页面录入及确认范围交接。
当前常规业务使用一个选定来源上下文处理直接列出的记录。目录请求为 `GET /window/agent`，返回 `principal` 与 `declarations`。每个目录成员以 `id`、`href` 提供来源身份与原文位置，原文中的 `declaration` 和 `principal` 必须与目录一致。

## 记录含义

```json
{
  "declaration": "DEC1",
  "principal": "AGENT-A",
  "branch": "CONTACT",
  "contact": "合成联系人",
  "origin": "CN",
  "approved": true
}
```

这里的字段是来源提供的原始声明，数值文本必须符合十进制规则，不能把空白或未知值转换成零。领域解释保留代理主体授权、分支字段核准、主体确认回读。只有所选范围内且有充分常规依据的记录列入当前收件；其他范围、待确认、历史和冲突分别保留结果，不用覆盖旧原文消除分歧。

## 本地合作源

`fixtures/source.json` 的 `resources` 是本地来源的 URL 路径到响应正文的映射；只绑定回环地址，不连接真实监管、银行或合作方。原文可通过目录声明的位置取得。同一来源也可发布关联资料，当前示例的关联资料位置为 `/window/agent/relations/DEC1`，字段保留来源的业务含义：

```json
{
  "shared": [
    "origin"
  ],
  "confirmations": [
    {
      "principal": "PRODUCER",
      "fields": [
        "origin"
      ],
      "revision": 1
    }
  ],
  "representatives": [
    "AGENT-A"
  ]
}
```

`fixtureSource` 支持独立实例、指定路径返回码、一次性来源故障、响应延迟与 `replace` 更新资源；访问记录保留实际请求路径，不凭空生成未收到的响应。测试在进程内操作夹具，不提供对外开放的管理接口。目录不承诺所有关联资料与当前目录同时发布；HTTP 404、403、503 不能自行解释为业务删除。

## 原文和收件

原文字节按 SHA-256 寻址，SQLite 保存来源位置、观察时间、收件范围、业务身份、领域记录与决策。收到原文不等于领域接收成功；重复的同一内容不新增收据，同一身份的不同内容不会覆盖原件。`.data/` 仅用于本机数据，演示使用临时目录，运行结束关闭服务并清理临时状态。

## 门户操作

`portalServer` 是本机合作门户，表单按来源业务身份打开，控件有可见标签。保存草稿和提交为不同操作，修订号变化会使旧页面提交失效。状态、依据和回执由服务端保存，浏览器回读后才能确认。`revise` 用于测试中模拟人工合法修订，服务端保留操作记录。页面的关联行来自现场已有记录，可以选择关联对象与去向；显示的来源记录不授权客户端绕过界面修改后端存储。

## 联合申报协作填报

联合申报目录为 `GET /window/joint`，每个申报给出确认范围资料（relations）位置与各分支原文位置。分支原文的法定主体身份以 `subject` 编码识别，`contact`/`contactName` 只是联系人展示字段：同名联系人不构成相同法定主体，代表人身份也不按联系人姓名推断。

### 确认范围资料

```json
{
  "declaration": "JDEC1",
  "shared": ["origin"],
  "subjects": [
    { "subject": "EXPORTER", "representatives": ["agent-a"], "editable": ["contact", "origin"] },
    { "subject": "PRODUCER", "representatives": ["agent-b"], "editable": ["goods", "packageCount"] }
  ],
  "confirmations": [
    { "subject": "PRODUCER", "branch": "B-FACTORY", "representative": "agent-b", "fields": ["origin", "goods"], "revision": 1 }
  ]
}
```

- `shared` 列出多主体共享字段；共享字段更正会使所有确认过该字段的主体确认失效。
- 门户只把当前代表人所属主体 `editable` 中的字段渲染为可写，其余字段只读回显；服务端对只读字段的篡改值返回 403，受托代理不能替其他主体签名。
- 确认与“主体 + 分支 + 代表人 + 字段值所在修订”绑定。字段在确认之后变化，旧确认进入 `superseded` 并区分仍有效字段（`validFields`）与失效字段（`invalidFields`）；代表人变更后旧代表人的确认进入 `representative-changed`，不被新代表人承接；缺少确认时原文时进入 `unverifiable`，不能假定旧确认仍然有效。
- 失效只登记“待哪个主体重新确认”（`pending`/`openItems`），不把整单退回空白，也不自动代签；不涉及该范围的其他分支继续办理。
- 同一修订号出现互相矛盾的事实值时判定 `conflict`，保留双方原文，不覆盖旧依据。

### 联合门户与回读

`jointPortalServer` 按 `/joint/{declaration}/{branch}?as={representative}` 打开分支页面。页面包含字段表单与确认面板（`data-confirmation`，标注每个主体确认的实际效力），并在 `data-snapshot` 中给出当前可编辑字段、只读字段与确认状态。写操作成功返回 303；修订号不一致返回 409，冲突页同样携带当前快照供自动化回读实际依据。

自动化（`operateJoint`）只通过可见界面填写快照中开放的字段，保存草稿与确认提交分步进行，并在提交前再次回读快照：保存失败、失效提示晚到、另一窗口在此期间补了共享字段，都会以阻断状态（`stale`、`changedFields`）返回，绝不凭点击成功写出“已确认”。最终受理以门户回执为准，`verifyJointPortal` 只核对当前账号有权编辑的字段与修订号。

### 落库与交接

`collectJoint` 把分支原文、确认范围原文分别按摘要保存，决策以 `kind: "joint"` 落库，记录可编辑范围、字段更正、失效确认评估与待办。恢复办理时 `handover` 基于资料库中实际保存的历次原文重新判定确认效力——旧确认不会被重新附在变化后的字段上。交接视图展示各主体实际确认过的内容、仍有效的部分、最近一次办理回执与待人工处理事项。
