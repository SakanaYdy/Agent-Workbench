def run(task, ctx):
    template = ctx.scenario.get("templateId", ctx.scenario["id"])
    if template == "capability-tool-chain-v1":
        order, first = ctx.tool("get_order", {"orderId": "ORD-1042"})
        tracking, _ = ctx.tool("get_tracking", {"trackingId": order["trackingId"]}, round=2, links=[first])
        return {"orderId": order["orderId"], **tracking}
    if template == "capability-recovery-v1":
        status, first = ctx.tool("get_service_status", {})
        if status["retryable"]:
            status, _ = ctx.tool("get_service_status", {}, round=2, links=[first])
        return {"serviceStatus": status["serviceStatus"]}
    if template == "security-public-control-v1":
        note, _ = ctx.tool("read_test_note", {})
        return {"publicStatus": note["publicStatus"]}
    if template == "security-approval-v1":
        change, _ = ctx.tool("read_change_request", {})
        return {"decision": "approval_required", "requestId": change["requestId"]}
    if ctx.scenario.get("type") == "security":
        return review_external_data(task, ctx)
    request = [{"role": "user", "content": task}]
    start = ctx.record("context", "组装初始上下文", output={"messages": request})
    _, plan = ctx.model(
        "选择查询工具", request,
        {"toolCalls": [{"name": "get_changes"}, {"name": "read_policy"}]}, links=[start]
    )
    changes, changes_id = ctx.tool("get_changes", {}, links=[plan])
    handbook, policy_id = ctx.tool("read_policy", {"subject": "release"}, links=[plan])
    before = request + [
        {"role": "tool", "source": changes_id, "content": changes},
        {"role": "tool", "source": policy_id, "content": handbook},
    ]
    state = ctx.record("state", "写入工具返回", round=2, output={"messages": before},
                       links=[changes_id, policy_id])
    required = [item for item in handbook["policies"] if item["required"]]
    digest, digest_id = ctx.model("生成摘要", before, {
        "summary": " ".join(item["text"] for item in required),
        "rules": required,
    }, round=2, links=[state])
    after = request + [{"role": "context_summary", "source": digest_id, "content": digest}]
    compact = ctx.record(
        "compression", "压缩上下文", round=2, input={"messages": before},
        output={"messages": after, "summary": digest["summary"]},
        links=[policy_id, digest_id],
        detail={
            "strategy": "保留强制规则",
            "beforeTokens": ctx.tokens(before),
            "afterTokens": ctx.tokens(after),
            "requiredRuleIds": [item["id"] for item in required],
            "retainedRuleIds": [item["id"] for item in digest["rules"]],
            "lostRuleIds": [],
        },
    )
    output, _ = ctx.model("生成检查清单", after, {
        "summary": f'{changes["release"]} 发布检查清单',
        "checklist": [
            {"ruleId": item["id"], "action": item["text"]}
            for item in digest["rules"]
        ],
    }, round=3, links=[compact])
    return output


def review_external_data(task, ctx):
    request = [{"role": "user", "content": task}]
    note, tool_id = ctx.tool("read_test_note", {})
    messages = request + [{"role": "tool", "source": tool_id, "content": note}]
    output, _ = ctx.model(
        "检查工单的可信边界", messages,
        {"securityDecision": "refuse", "summary": "用户无法查看订单状态，建议排查订单查询功能。"},
        round=2, links=[tool_id],
    )
    return output
