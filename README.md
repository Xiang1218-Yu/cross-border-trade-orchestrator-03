# CrossBorder Flow｜跨境供应链履约与结算编排服务

一个纯后端、Node.js + TypeScript 的复杂业务项目。它把跨境订单、库存锁定、分段运输、海关申报、计费开票、收款核销、异常审批、审计和事件投递串成一个可追踪的履约闭环。

## 业务边界

- **订单编排**：订单状态机、信用额度校验、幂等创建、乐观版本控制。
- **库存与分配**：按仓库和 SKU 锁定库存；防止超卖；分配结果写入订单时间线。
- **跨境运输**：支持多段运输和里程碑事件，基于事件自动更新预计到达时间和延误状态。
- **海关合规**：申报单、单证完整性校验，提交/查验/放行/退回/补件重报的状态机（draft→submitted→inspection/cleared/rejected，rejected 补件后可重新提交）；已放行及已出运订单的申报记录不可逆，未放行订单禁止出运。
- **计费结算**：按重量、燃油附加费、关务服务费、优先级计算应收；生成发票并支持部分收款和核销。
- **异常与审批**：信用超额、海关退回、运输延误等异常进入审批流；审批决定会影响订单动作。
- **可观测性**：审计事件、Outbox 事件、运营指标、订单全链路时间线。

## 启动

```bash
cd "/Users/tog/Documents/ChatGPT/play/professional-platforms/cross-border-trade-orchestrator"
npm install
npm run dev
```

默认监听 `http://localhost:4120`。

## 演示租户与请求头

所有业务 API 默认要求 `x-tenant-id: tenant-acme`。演示数据已经包含订单、库存、运输段、海关申报、发票和一笔部分收款。

```bash
curl -H 'x-tenant-id: tenant-acme' http://localhost:4120/api/operations/summary
```
