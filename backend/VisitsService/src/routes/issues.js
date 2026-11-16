const express = require('express');
const { authenticateToken, requireRole } = require('../middleware/auth');
const prisma = require('../utils/prisma');
const { logAction } = require('../utils/auditLog');

const router = express.Router();
const STATUSES = ['NEW', 'IN_PROGRESS', 'WAITING', 'ESCALATED', 'RESOLVED', 'REJECTED', 'CLOSED'];
const CATEGORIES = ['REQUEST', 'MATERIALS', 'PAYMENT', 'DEVICE', 'ACCOUNT', 'TRAINING', 'COMPLAINT', 'OTHER'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const NETWORKS = ['IREMBO', 'MOOLA_PLUS', 'COMBINED'];
const PERSON = { id: true, username: true, firstName: true, lastName: true };
const ISSUE_LIST_INCLUDE = {
  reporter: { select: PERSON },
  assignedTo: { select: PERSON },
  _count: { select: { comments: true } },
};

const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const asName = (person) => person ? `${person.firstName} ${person.lastName}`.trim() || person.username : null;
const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isAdmin = (user) => user.role === 'ADMIN';
const issueAccessWhere = (user) => isAdmin(user) ? {} : { reporterId: user.id };
const routeError = (res, error, fallback = 'The issue could not be saved. Please retry.') => {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
  console.error(JSON.stringify({ event: 'issue_request_failed', code: error.code || error.name }));
  return res.status(503).json({ error: fallback });
};

router.get('/admins', authenticateToken, requireRole('ADMIN', 'TC'), async (_req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: PERSON,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    res.json({ data: admins.map((person) => ({ ...person, name: asName(person) })) });
  } catch (error) {
    routeError(res, error, 'Could not load the administrator list.');
  }
});

router.get('/', authenticateToken, requireRole('ADMIN', 'TC'), async (req, res) => {
  try {
    const status = clean(req.query.status, 24).toUpperCase();
    const search = clean(req.query.search, 100);
    const where = { ...issueAccessWhere(req.user) };
    if (STATUSES.includes(status)) where.status = status;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        { agentName: { contains: search, mode: 'insensitive' } },
        { agentCode: { contains: search, mode: 'insensitive' } },
        { agentPhone: { contains: search, mode: 'insensitive' } },
        { reporter: { is: { firstName: { contains: search, mode: 'insensitive' } } } },
        { reporter: { is: { lastName: { contains: search, mode: 'insensitive' } } } },
      ];
    }
    const rows = await prisma.issue.findMany({
      where,
      include: ISSUE_LIST_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    res.json({ data: rows.map((issue) => ({ ...issue, reporterName: asName(issue.reporter), assignedToName: asName(issue.assignedTo) })) });
  } catch (error) {
    routeError(res, error, 'Could not load issues. Please retry.');
  }
});

router.post('/', authenticateToken, requireRole('TC'), async (req, res) => {
  const title = clean(req.body?.title, 200);
  const description = clean(req.body?.description, 5000);
  const assignedToId = clean(req.body?.assignedToId, 64);
  const category = clean(req.body?.category, 32).toUpperCase();
  const priority = clean(req.body?.priority, 16).toUpperCase();
  const network = clean(req.body?.network, 16).toUpperCase();
  if (title.length < 3) return res.status(400).json({ error: 'Enter a short issue title (at least 3 characters).' });
  if (!description) return res.status(400).json({ error: 'Describe the issue so the administrator can investigate it.' });
  if (!isUuid(assignedToId)) return res.status(400).json({ error: 'Choose an administrator to receive this issue.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Choose a valid issue type.' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Choose a valid priority.' });
  if (!NETWORKS.includes(network)) return res.status(400).json({ error: 'Choose a valid network.' });

  try {
    const admin = await prisma.user.findFirst({ where: { id: assignedToId, role: 'ADMIN', isActive: true }, select: { id: true } });
    if (!admin) return res.status(400).json({ error: 'That administrator is not active. Choose another administrator.' });
    const issue = await prisma.$transaction(async (tx) => {
      const [sequence] = await tx.$queryRaw`SELECT nextval('issue_code_seq')::text AS value`;
      const year = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Kigali', year: 'numeric' }).format(new Date());
      const code = `ISS-${year}-${String(sequence.value).padStart(5, '0')}`;
      return tx.issue.create({
        data: {
          code,
          title,
          description,
          category,
          priority,
          network,
          reporterId: req.user.id,
          assignedToId: admin.id,
          agentName: clean(req.body?.agentName, 200),
          agentPhone: clean(req.body?.agentPhone, 32),
          agentCode: clean(req.body?.agentCode, 80),
          province: clean(req.body?.province, 80),
          district: clean(req.body?.district, 80),
          sector: clean(req.body?.sector, 80),
          cell: clean(req.body?.cell, 80),
          village: clean(req.body?.village, 80),
          comments: { create: { authorId: req.user.id, assignedToId: admin.id } },
        },
        include: ISSUE_LIST_INCLUDE,
      });
    });
    await logAction(req.user.id, 'CREATE_FIELD_ISSUE', 'Issue', issue.id, { code: issue.code, category: issue.category, priority: issue.priority }, req);
    res.status(201).json({ data: { ...issue, reporterName: asName(issue.reporter), assignedToName: asName(issue.assignedTo) } });
  } catch (error) {
    routeError(res, error);
  }
});

router.get('/:id', authenticateToken, requireRole('ADMIN', 'TC'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
  try {
    const issue = await prisma.issue.findFirst({
      where: { id: req.params.id, ...issueAccessWhere(req.user) },
      include: {
        reporter: { select: PERSON },
        assignedTo: { select: PERSON },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: PERSON }, assignedTo: { select: PERSON } },
        },
      },
    });
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    res.json({ data: { ...issue, reporterName: asName(issue.reporter), assignedToName: asName(issue.assignedTo) } });
  } catch (error) {
    routeError(res, error, 'Could not load this issue. Please retry.');
  }
});

router.post('/:id/replies', authenticateToken, requireRole('ADMIN', 'TC'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Issue not found.' });
  const body = clean(req.body?.body, 5000);
  const nextStatus = clean(req.body?.status, 24).toUpperCase();
  const hasStatus = Boolean(nextStatus);
  const hasAssignee = Object.prototype.hasOwnProperty.call(req.body || {}, 'assignedToId');
  const requestedAssignee = hasAssignee ? clean(req.body.assignedToId, 64) : undefined;
  if (hasStatus && !STATUSES.includes(nextStatus)) return res.status(400).json({ error: 'Choose a valid status.' });
  if (hasAssignee && !isAdmin(req.user)) return res.status(403).json({ error: 'Only an administrator can reassign an issue.' });
  if (hasAssignee && !isUuid(requestedAssignee)) return res.status(400).json({ error: 'Choose an active administrator.' });
  if (['WAITING', 'ESCALATED', 'RESOLVED', 'REJECTED'].includes(nextStatus) && !body) {
    return res.status(400).json({ error: 'Add a note explaining this status change.' });
  }

  try {
    const issue = await prisma.issue.findFirst({ where: { id: req.params.id, ...issueAccessWhere(req.user) } });
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    if (nextStatus === issue.status) return res.status(400).json({ error: 'Choose a status different from the current one.' });
    if (!isAdmin(req.user) && hasStatus) {
      const canCloseResolved = nextStatus === 'CLOSED' && issue.status === 'RESOLVED';
      const canReopen = nextStatus === 'NEW' && ['RESOLVED', 'REJECTED', 'CLOSED'].includes(issue.status);
      if (!canCloseResolved && !canReopen) return res.status(403).json({ error: 'You can close a resolved issue or reopen a finished issue.' });
    }
    if (!body && !hasStatus && !hasAssignee) return res.status(400).json({ error: 'Write a reply or change the issue status.' });

    let assignee = null;
    if (hasAssignee) {
      assignee = await prisma.user.findFirst({ where: { id: requestedAssignee, role: 'ADMIN', isActive: true }, select: { id: true } });
      if (!assignee) return res.status(400).json({ error: 'That administrator is not active. Choose another administrator.' });
      if (assignee.id === issue.assignedToId) return res.status(400).json({ error: 'This issue is already assigned to that administrator.' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const status = hasStatus ? nextStatus : issue.status;
      await tx.issueComment.create({
        data: {
          issueId: issue.id,
          authorId: req.user.id,
          body,
          statusFrom: hasStatus ? issue.status : null,
          statusTo: hasStatus ? nextStatus : null,
          assignedToId: assignee?.id || null,
        },
      });
      return tx.issue.update({
        where: { id: issue.id },
        data: {
          ...(hasStatus ? { status, resolvedAt: ['RESOLVED', 'REJECTED'].includes(status) ? new Date() : null, closedAt: status === 'CLOSED' ? new Date() : null } : {}),
          ...(assignee ? { assignedToId: assignee.id } : {}),
        },
        include: ISSUE_LIST_INCLUDE,
      });
    });
    await logAction(req.user.id, hasStatus ? 'UPDATE_FIELD_ISSUE' : 'REPLY_FIELD_ISSUE', 'Issue', issue.id, {
      code: issue.code,
      ...(hasStatus ? { from: issue.status, to: nextStatus } : {}),
      ...(assignee ? { assignedToId: assignee.id } : {}),
    }, req);
    res.json({ data: { ...updated, reporterName: asName(updated.reporter), assignedToName: asName(updated.assignedTo) } });
  } catch (error) {
    routeError(res, error);
  }
});

module.exports = router;
