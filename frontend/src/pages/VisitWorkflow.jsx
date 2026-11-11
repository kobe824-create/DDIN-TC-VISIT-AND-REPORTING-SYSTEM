import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { 
  Search, 
  MapPin, 
  Camera, 
  ArrowRight,
  CheckCircle, 
  AlertTriangle, 
  ArrowLeft,
  RefreshCw,
  FileText,
  Phone,
  Check,
  CalendarDays,
} from 'lucide-react';
import api from '../api';
import FormField from '../components/FormField';
import ListPagination from '../components/ListPagination';
import { useAuth } from '../AuthContext';
import { getAgentPack, getVisitDrafts, saveVisitDraft } from '../offline/store';
import { MOOLA_PLUS_NETWORK, useNetwork } from '../NetworkContext';

const makeClientVisitId = () => `CLT-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const kigaliDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const coverageIsActive = (agent, now = new Date()) => Boolean(agent?.coverageEndsAt && new Date(agent.coverageEndsAt) > now && agent.lastQualifiedVisitAt && new Date(agent.lastQualifiedVisitAt) <= now);
const distanceMeters = (a, b) => {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};
const acquireBestLocation = (durationMs = 45000) => new Promise((resolve, reject) => {
  if (!navigator.geolocation?.watchPosition) { reject(new Error('This browser does not provide GPS readings.')); return; }
  let best = null;
  let goodReadings = 0;
  let watchId = null;
  const finish = (error) => {
    window.clearTimeout(timer);
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (error && !best) reject(error);
    else if (best) resolve(best);
    else reject(new Error('No location reading was received. Move near a window or outdoors and try again.'));
  };
  const timer = window.setTimeout(() => finish(), durationMs);
  try {
    watchId = navigator.geolocation.watchPosition((position) => {
      const timestamp = Number(position.timestamp) || Date.now();
      if (Date.now() - timestamp > 30000 || !Number.isFinite(position.coords?.accuracy)) return;
      if (!best || position.coords.accuracy < best.coords.accuracy) best = position;
      if (position.coords.accuracy <= 30) goodReadings += 1;
      if (goodReadings >= 2) finish();
    }, (error) => {
      if (error.code === 1) finish(new Error('Location access was denied. Allow location access in browser settings, then try again.'));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: durationMs });
  } catch (error) { finish(error); }
});

const STEPS = ['Select Agent', 'Check In', 'Photo', 'Report', 'Review'];
const isAgentLocationQuestion = (text) => /\bagent\s+(district|sector|cell|village|venue)\s+location\b/i.test(String(text || ''));
const withoutDuplicateVisitQuestions = (items) => items.filter((item) => !isAgentLocationQuestion(item.text));
const mapMoolaVisitAgent = (agent, territories = []) => {
  const location = agent.fieldLocation;
  const districtName = String(location?.district || agent.district || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const assignedTerritory = territories.find((territory) => String(territory.name || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ') === districtName);
  return {
    ...agent,
    moolaPlus: true,
    agentId: agent.loginName || agent.id,
    phoneNumber: agent.phone || '',
    businessName: agent.businessType || agent.agentCategory || 'Moola Plus agent',
    address: [location?.district || agent.district, location?.sector || agent.sector, agent.city].filter(Boolean).join(' · '),
    territoryId: location?.territoryId || assignedTerritory?.id || '',
    territory: { name: location?.district || agent.district || assignedTerritory?.name || '' },
    registeredLatitude: location?.latitude ?? null,
    registeredLongitude: location?.longitude ?? null,
    gpsAccuracy: location?.accuracy ?? null,
    locationVerified: Boolean(location?.locationVerified),
    sectorId: location?.sectorId || '',
    cellId: location?.cellId || '',
    villageId: location?.villageId || '',
    firstVisitLocationCapturedAt: location?.firstLocationCapturedAt || null,
    firstVisitCompletedAt: location?.firstVisitCompletedAt || null,
    venue: location?.venue || '',
    moolaPendingRelocation: location?.pendingRelocation || null,
    transfers: agent.pendingTransfer ? [agent.pendingTransfer] : [],
  };
};

export default function VisitWorkflow() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { network } = useNetwork();
  const isMoolaPlus = network === MOOLA_PLUS_NETWORK;

  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState(null);
  const [agents, setAgents] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentTotal, setAgentTotal] = useState(0);
  const [agentPages, setAgentPages] = useState(0);
  const [agentPage, setAgentPage] = useState(1);
  const [agentPageSize, setAgentPageSize] = useState(25);
  const [checklist, setChecklist] = useState([]);
  const [checklistData, setChecklistData] = useState({});
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [offlinePack, setOfflinePack] = useState(null);
  const [workTerritoryId, setWorkTerritoryId] = useState('');
  const [workSectorIds, setWorkSectorIds] = useState([]);
  const [workCellIds, setWorkCellIds] = useState([]);
  const [workVillageIds, setWorkVillageIds] = useState([]);
  const [plans, setPlans] = useState([]);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [browseMode, setBrowseMode] = useState('MANUAL');
  const [workload, setWorkload] = useState(null);
  const [workloadOpen, setWorkloadOpen] = useState(false);
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [firstVisitFields, setFirstVisitFields] = useState({ territoryId: '', sectorId: '', cellId: '', cellName: '', villageId: '', villageName: '', venue: '' });
  const [transferPanelOpen, setTransferPanelOpen] = useState(false);
  const [transferTargets, setTransferTargets] = useState([]);
  const [transferTargetsLoaded, setTransferTargetsLoaded] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState('');
  const [transferRecipientId, setTransferRecipientId] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferRequested, setTransferRequested] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState(100);
  const [clientVisitId, setClientVisitId] = useState(null);
  const [offlineVisit, setOfflineVisit] = useState(false);
  
  const [visitId, setVisitId] = useState(null);
  const [gpsStatus, setGpsStatus] = useState(null); // acquiring, success, low_accuracy, outside_radius, error
  const [gpsData, setGpsData] = useState(null);
  const [locationMethod, setLocationMethod] = useState('GPS');
  const [metricEligible, setMetricEligible] = useState(null);
  const [checkInCoordinates, setCheckInCoordinates] = useState(null);
  const [checkInLoading, setCheckInLoading] = useState(false);
  const [locationCaptureLoading, setLocationCaptureLoading] = useState(false);
  
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoUploadStage, setPhotoUploadStage] = useState('');
  const [photoUploadProgress, setPhotoUploadProgress] = useState(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const cameraRequestRef = useRef(0);

  const [savedReportPayload, setSavedReportPayload] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  
  const [checkOutLoading, setCheckOutLoading] = useState(false);
  const [visitCompleted, setVisitCompleted] = useState(false);
  const [completionResult, setCompletionResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const applyPack = (pack) => {
      if (!pack || cancelled) return;
      setOfflinePack(pack);
      if (Array.isArray(pack.territories) && pack.territories.length) setWorkTerritoryId((current) => current || pack.territories[0].id);
      setRadiusMeters(Number(pack.radiusMeters) || 100);
      const items = Array.isArray(pack.checklistSchema) ? pack.checklistSchema : [];
      setChecklist(withoutDuplicateVisitQuestions(items).map((item, index) => ({ ...item, id: item.id || `question-${index + 1}`, section: item.section || 'DDIN', required: !isMoolaPlus && item.section === 'IREMBO' })));
    };
    (async () => {
      if (user?.role?.toUpperCase() === 'TC') {
        if (isMoolaPlus) {
          try {
            const [{ data: territories }, { data: config }, { data: geofence }] = await Promise.all([
              api.get('/api/v1/territories'),
              api.get('/api/v1/config/checklist').catch(() => ({ data: { schema: [] } })),
              api.get('/api/v1/config/geofence').catch(() => ({ data: { radiusMeters: 100 } })),
            ]);
            const schema = config.schema;
            const items = Array.isArray(schema) ? schema : Array.isArray(schema?.questions) ? schema.questions : [];
            const byId = new Map(territories.map((item) => [item.id, { ...item, children: [] }]));
            for (const item of byId.values()) {
              if (item.parentId && byId.has(item.parentId)) byId.get(item.parentId).children.push(item);
            }
            const hierarchy = [...byId.values()].filter((item) => item.type === 'DISTRICT');
            applyPack({ territories: hierarchy, checklistSchema: items, radiusMeters: geofence.radiusMeters });
          } catch (error) {
            if (!cancelled) setError(error.response?.data?.error || 'Could not load your assigned districts for Moola Plus visits.');
          }
          return;
        }
        try { applyPack(await getAgentPack(user.id)); } catch { /* The online request below can still prepare the package. */ }
        try {
          const { data } = await api.get('/api/v1/agents/offline-pack');
          applyPack(data);
          return;
        } catch { /* Use the saved field package while offline. */ }
      }
      try {
        const { data } = await api.get('/api/v1/config/checklist');
        const schema = data.schema;
        const items = Array.isArray(schema) ? schema : Array.isArray(schema?.questions) ? schema.questions : [];
        if (!cancelled) setChecklist(withoutDuplicateVisitQuestions(items).map((item, index) => ({ ...item, id: item.id || `question-${index + 1}`, section: item.section || 'DDIN', required: !isMoolaPlus && item.section === 'IREMBO' })));
      } catch { if (!cancelled) setChecklist([]); }
    })();
    return () => { cancelled = true; };
  }, [user?.id, user?.role, isMoolaPlus]);

  useEffect(() => {
    setCurrentStep(0);
    setSelectedAgent(null);
    setGpsStatus(null);
    setVisitId(null);
    setClientVisitId(null);
    setOfflineVisit(false);
    setError(null);
  }, [network]);

  useEffect(() => {
    setSelectedPlanId('');
    setBrowseMode('MANUAL');
  }, [network]);

  useEffect(() => {
    if (user?.role?.toUpperCase() !== 'TC') return undefined;
    let cancelled = false;
    const today = kigaliDateKey();
    const cacheKey = `field-plans-${network}-${user.id}`;
    const previousMonthDate = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
    previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1);
    const previousMonth = previousMonthDate.toISOString().slice(0, 7);
    const load = async () => {
      try {
        const planParams = { network: 'COMBINED' };
        const requests = [
          api.get('/api/v1/reports/field-progress/plans', { params: { ...planParams, month: previousMonth } }),
          api.get('/api/v1/reports/field-progress/plans', { params: { ...planParams, month: today.slice(0, 7) } }),
        ];
        requests.push(api.get('/api/v1/reports/field-progress/daily-workload'));
        const [previousPlansResponse, currentPlansResponse, workloadResponse] = await Promise.all(requests);
        if (cancelled) return;
        const planRows = [...(previousPlansResponse.data || []), ...(currentPlansResponse.data || [])];
        const workloadData = workloadResponse?.data || null;
        const usablePlans = (Array.isArray(planRows) ? planRows : []).filter((plan) => {
          const start = String(plan.planDate).slice(0, 10);
          const end = String(plan.endDate || plan.planDate).slice(0, 10);
          return start <= today && end >= today;
        });
        setPlans(usablePlans);
        try { window.localStorage.setItem(cacheKey, JSON.stringify(usablePlans)); } catch { /* Plans remain available while this page is open. */ }
        const activePlan = usablePlans[0];
        if (activePlan) { setSelectedPlanId(activePlan.id); setBrowseMode('PLAN'); }
        setWorkload(workloadData);
        if (workloadData) try { window.localStorage.setItem(`field-workload-${user.id}`, JSON.stringify(workloadData)); } catch { /* The live workload remains available in memory. */ }
        if (workloadData?.isWorkday && workloadData.remainingTarget > 0) {
          const dismissedKey = `field-workload-dismissed-${user.id}-${workloadData.date}`;
          if (window.localStorage.getItem(dismissedKey) !== '1') setWorkloadOpen(true);
        }
      } catch {
        if (cancelled) return;
        try {
          const cachedPlans = JSON.parse(window.localStorage.getItem(cacheKey) || '[]');
          if (Array.isArray(cachedPlans)) setPlans(cachedPlans);
          const cachedWorkload = JSON.parse(window.localStorage.getItem(`field-workload-${user.id}`) || 'null');
          if (cachedWorkload) setWorkload(cachedWorkload);
        } catch { /* There is no saved plan or workload yet. */ }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user?.id, user?.role, isMoolaPlus, network]);

  useEffect(() => {
    if (browseMode !== 'PLAN' || !selectedPlanId) return;
    const plan = plans.find((item) => item.id === selectedPlanId);
    if (!plan) return;
    let territory = plan.territory;
    while (territory && territory.type !== 'DISTRICT') territory = territory.parent;
    setWorkTerritoryId(territory?.id || '');
    setWorkSectorIds(plan.territory?.type === 'SECTOR' ? [plan.territory.id] : []);
    setWorkCellIds(plan.territory?.type === 'CELL' ? [plan.territory.id] : []);
    setWorkVillageIds(plan.territory?.type === 'VILLAGE' ? [plan.territory.id] : []);
    setAgentPage(1);
  }, [browseMode, plans, selectedPlanId]);

  useEffect(() => {
    const territories = offlinePack?.territories || [];
    if (!workTerritoryId) return;
    if (!territories.length || territories.some((territory) => territory.id === workTerritoryId)) return;
    setWorkTerritoryId(territories[0].id);
    setWorkSectorIds([]);
    setWorkCellIds([]);
    setWorkVillageIds([]);
  }, [offlinePack, workTerritoryId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const selectedPlan = browseMode === 'PLAN' ? plans.find((plan) => plan.id === selectedPlanId) : null;
      const priorityAgentIds = priorityOnly ? (workload?.dueAgents || [])
        .map((agent) => isMoolaPlus ? agent.externalAgentId : agent.localAgentId)
        .filter(Boolean) : [];
      setAgentsLoading(true);
      setError(null);
      try {
        if (isMoolaPlus) {
          const selectedTerritory = offlinePack?.territories?.find((territory) => territory.id === workTerritoryId);
          const areaById = new Map();
          const addAreaTree = (area) => { if (!area) return; areaById.set(area.id, area); (area.children || []).forEach(addAreaTree); };
          (offlinePack?.territories || []).forEach(addAreaTree);
          const areaFilters = {};
          if (selectedPlan) {
            const path = [];
            let item = selectedPlan.territory;
            while (item) { path.unshift(item); item = item.parent; }
            const province = path.find((area) => area.type === 'PROVINCE');
            const district = path.find((area) => area.type === 'DISTRICT');
            const sector = path.find((area) => area.type === 'SECTOR');
            const cell = path.find((area) => area.type === 'CELL');
            const village = path.find((area) => area.type === 'VILLAGE');
            if (province) areaFilters.provinceId = province.id;
            if (district) areaFilters.territoryId = district.id;
            if (sector) areaFilters.sectorId = sector.id;
            if (cell) areaFilters.cellId = cell.id;
            if (village) areaFilters.villageId = village.id;
          } else {
            if (selectedTerritory?.id) areaFilters.territoryId = selectedTerritory.id;
            if (workSectorIds.length) areaFilters.sectorId = workSectorIds[0];
            if (workCellIds.length) areaFilters.cellId = workCellIds[0];
            if (workVillageIds.length) areaFilters.villageId = workVillageIds[0];
          }
          const { data } = await api.get('/api/v1/reports/moola-plus/agents', {
            params: { page: agentPage, limit: agentPageSize, agentIds: priorityAgentIds.length ? priorityAgentIds.join(',') : undefined, search: searchQuery.trim() || undefined, ...areaFilters },
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          const mapped = (data.data || []).map((agent) => {
            const mappedAgent = mapMoolaVisitAgent(agent, offlinePack?.territories || []);
            return { ...mappedAgent, territoryId: mappedAgent.territoryId || selectedTerritory?.id || workTerritoryId };
          });
          setAgents(mapped);
          setAgentTotal(data.total || 0);
          setAgentPages(data.pages || 0);
          setAgentPage(data.page || 1);
          return;
        }
        const { data } = await api.get('/api/v1/agents', {
          params: {
            page: agentPage, limit: agentPageSize, search: searchQuery.trim() || undefined,
            ...(selectedPlan ? { planId: selectedPlan.id } : {
              territoryId: workTerritoryId || undefined,
              sectorIds: workSectorIds.length ? workSectorIds : undefined,
              cellIds: workCellIds.length ? workCellIds : undefined,
              villageIds: workVillageIds.length ? workVillageIds : undefined,
            }),
            ...(priorityAgentIds.length ? { priorityAgentIds } : {}),
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setAgents(data.data || []);
        setAgentTotal(data.total ?? data.data?.length ?? 0);
        setAgentPages(data.pages ?? 0);
        setAgentPage(data.page ?? agentPage);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (isMoolaPlus) {
          setError(err.response?.data?.error || 'Could not load the upstream Moola Plus agents. Connect to the network and retry.');
          return;
        }
        try {
          const pack = offlinePack || await getAgentPack(user?.id);
          if (!pack?.agents) throw new Error('No saved field package. Connect once to download your assigned agents for offline visits.');
          const query = searchQuery.trim().toLocaleLowerCase();
          const areaIds = [...workSectorIds, ...workCellIds, ...workVillageIds];
          const selectedPlan = browseMode === 'PLAN' ? plans.find((plan) => plan.id === selectedPlanId) : null;
          const priorityIdSet = new Set((priorityOnly ? workload?.dueAgents || [] : []).map((agent) => agent.id));
          const filtered = pack.agents.filter((agent) => {
            const transferToSelected = agent.transfers?.some((transfer) => transfer.toTerritoryId === workTerritoryId);
            if (selectedPlan) {
              const area = selectedPlan.territory;
              let matchesArea = area?.type === 'DISTRICT' ? agent.territoryId === area.id
                : area?.type === 'SECTOR' ? agent.sectorId === area.id
                  : area?.type === 'CELL' ? agent.cellId === area.id
                    : area?.type === 'VILLAGE' ? agent.villageId === area.id
                      : area?.type === 'PROVINCE' && pack.territories?.some((district) => district.id === agent.territoryId && district.parentId === area.id);
              if (!matchesArea && !transferToSelected) return false;
            } else {
              if (workTerritoryId && agent.territoryId !== workTerritoryId && !transferToSelected) return false;
              if (areaIds.length && !transferToSelected && !areaIds.some((id) => [agent.sectorId, agent.cellId, agent.villageId].includes(id))) return false;
            }
            if (priorityOnly && priorityIdSet.size && !priorityIdSet.has(agent.id)) return false;
            return !query || [agent.name, agent.phoneNumber, agent.agentId, agent.businessName, agent.venue, agent.address].some((value) => String(value || '').toLocaleLowerCase().includes(query));
          });
          const pages = Math.ceil(filtered.length / agentPageSize);
          const page = Math.min(agentPage, Math.max(pages, 1));
          const start = (page - 1) * agentPageSize;
          setAgents(filtered.slice(start, start + agentPageSize));
          setAgentTotal(filtered.length);
          setAgentPages(pages);
          setAgentPage(page);
          setRadiusMeters(Number(pack.radiusMeters) || 100);
          if (Array.isArray(pack.checklistSchema)) setChecklist(withoutDuplicateVisitQuestions(pack.checklistSchema).map((item, index) => ({ ...item, id: item.id || `question-${index + 1}`, section: item.section || 'DDIN', required: item.section === 'IREMBO' })));
          setError(null);
        } catch (offlineError) { setError(offlineError.message || err.response?.data?.error || 'Could not load agents. Check your connection and try again.'); }
      } finally {
        if (!controller.signal.aborted) setAgentsLoading(false);
      }
    }, searchQuery.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [agentPage, agentPageSize, searchQuery, offlinePack, user?.id, workTerritoryId, workSectorIds, workCellIds, workVillageIds, isMoolaPlus, plans, selectedPlanId, browseMode, priorityOnly, workload?.date]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id || isMoolaPlus) return undefined;
    (async () => {
      try {
        const drafts = await getVisitDrafts(user.id);
        const draft = [...drafts].reverse().find((item) => !item.completed && item.selectedAgent && item.checkInTime);
        if (!draft || cancelled) return;
        if (draft.gpsData?.locationStatus !== 'VERIFIED' || draft.locationMethod === 'MANUAL_EVIDENCE' || !draft.checkInCoordinates) {
          setError('This saved visit does not have a verified GPS check-in. Start again while within the configured radius of the agent.');
          return;
        }
        setClientVisitId(draft.clientVisitId);
        setVisitId(draft.serverVisitId || draft.clientVisitId);
        setOfflineVisit(!draft.serverVisitId);
        setSelectedAgent(draft.selectedAgent);
        const pendingLocation = draft.selectedAgent?.pendingLocation || {};
        setFirstVisitFields({
          territoryId: pendingLocation.territoryId || draft.selectedAgent?.territoryId || '',
          sectorId: pendingLocation.sectorId || draft.selectedAgent?.sectorId || '',
          cellId: pendingLocation.cellId || draft.selectedAgent?.cellId || '',
          cellName: pendingLocation.cellName || draft.selectedAgent?.cell?.name || '',
          villageId: pendingLocation.villageId || draft.selectedAgent?.villageId || '',
          villageName: pendingLocation.villageName || draft.selectedAgent?.village?.name || '',
          venue: pendingLocation.venue || draft.selectedAgent?.venue || '',
        });
        setGpsData(draft.gpsData || null);
        setLocationMethod(draft.locationMethod || draft.gpsData?.locationMethod || 'GPS');
        setCheckInCoordinates(draft.checkInCoordinates || null);
        setGpsStatus('success');
        setCurrentStep(draft.currentStep || 1);
        setChecklistData(draft.checklistData || {});
        setSavedReportPayload(draft.reportPayload || null);
        if (draft.photoBlob) {
          const file = new File([draft.photoBlob], draft.photoName || 'offline-visit.jpg', { type: draft.photoType || 'image/jpeg' });
          setPhotoFile(file);
          setPhotoPreview(URL.createObjectURL(file));
        }
        if (draft.reportPayload) setCurrentStep(Math.max(draft.currentStep || 1, 3));
        if (draft.reportPayload && draft.photoBlob) setCurrentStep(Math.max(draft.currentStep || 1, 4));
      } catch { /* Offline drafts remain on the device if storage cannot be read. */ }
      })();
    return () => { cancelled = true; };
  }, [user?.id, isMoolaPlus]);

  useEffect(() => {
    if (agentPages && agentPage > agentPages) setAgentPage(agentPages);
  }, [agentPage, agentPages]);

  useEffect(() => {
    if (!cameraActive || !videoRef.current || !cameraStreamRef.current) return undefined;
    videoRef.current.srcObject = cameraStreamRef.current;
    videoRef.current.play().catch(() => setCameraError('The camera preview could not start. Close other camera apps and try again.'));
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [cameraActive]);

  useEffect(() => () => {
    cameraRequestRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
  }, [currentStep]);

  useEffect(() => () => {
    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  const handleAgentSelect = (agent) => {
    setSelectedAgent(agent);
    setChecklistData({});
    setSavedReportPayload(null);
    const incomingTransfer = agent.transfers?.find((transfer) => transfer.status === 'PENDING') || agent.transfers?.[0];
    const transferChangesDistrict = Boolean(incomingTransfer?.acceptedAt && incomingTransfer?.toTerritoryId && incomingTransfer.toTerritoryId !== agent.territoryId);
    setFirstVisitFields({
      territoryId: (incomingTransfer?.acceptedAt ? incomingTransfer.toTerritoryId : agent.territoryId) || workTerritoryId,
      sectorId: transferChangesDistrict ? '' : agent.sectorId || '',
      cellId: transferChangesDistrict ? '' : agent.cellId || '',
      cellName: transferChangesDistrict ? '' : agent.cell?.name || '',
      villageId: transferChangesDistrict ? '' : agent.villageId || '',
      villageName: transferChangesDistrict ? '' : agent.village?.name || '',
      venue: agent.venue || '',
    });
    setTransferPanelOpen(false);
    setTransferTargets([]);
    setTransferTargetsLoaded(false);
    setTransferRequested(false);
    setGpsStatus(null);
    setGpsData(null);
    setLocationMethod('GPS');
    setClientVisitId(null);
    setVisitId(null);
    setOfflineVisit(false);
    setCurrentStep(1);
    setError(null);
  };

  useEffect(() => {
    const requestedId = searchParams.get('agentId');
    if (isMoolaPlus || !requestedId || selectedAgent?.id === requestedId) return undefined;
    const controller = new AbortController();
    api.get(`/api/v1/agents/${encodeURIComponent(requestedId)}`, { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      setWorkTerritoryId(data.territoryId || '');
      handleAgentSelect(data);
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.response?.data?.error || 'Could not load this Irembo agent for a visit.');
    });
    return () => controller.abort();
  }, [isMoolaPlus, searchParams, selectedAgent?.id]);

  useEffect(() => {
    const requestedId = searchParams.get('externalAgentId');
    if (!isMoolaPlus || !requestedId || selectedAgent?.id === requestedId) return;
    const availableTerritories = offlinePack?.territories || [];
    if (user?.role?.toUpperCase() === 'TC' && !availableTerritories.length) return;
    const controller = new AbortController();
    api.get(`/api/v1/reports/moola-plus/agents/${encodeURIComponent(requestedId)}`, { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      const requestedAgent = mapMoolaVisitAgent(data.data, availableTerritories);
      if (!requestedAgent.territoryId) {
        setError('This agent’s district is not in your assigned visit areas.');
        return;
      }
      setWorkTerritoryId(requestedAgent.territoryId);
      handleAgentSelect(requestedAgent);
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.response?.data?.error || 'Could not load this Moola Plus agent.');
    });
    return () => controller.abort();
  }, [isMoolaPlus, searchParams, selectedAgent?.id, offlinePack?.territories, user?.role]);

  const persistDraft = async (overrides = {}) => {
    const id = overrides.clientVisitId || clientVisitId;
    if (!id || !user?.id) return;
    const captured = {
      clientVisitId: id,
      serverVisitId: overrides.serverVisitId !== undefined ? overrides.serverVisitId : (offlineVisit ? null : visitId),
      selectedAgent: overrides.selectedAgent || selectedAgent,
      checkInCoordinates: overrides.checkInCoordinates !== undefined ? overrides.checkInCoordinates : checkInCoordinates,
      gpsData: overrides.gpsData || gpsData,
      locationMethod: overrides.locationMethod || locationMethod,
      currentStep: overrides.currentStep ?? currentStep,
      photoFile: overrides.photoFile !== undefined ? overrides.photoFile : photoFile,
      reportPayload: overrides.reportPayload !== undefined ? overrides.reportPayload : savedReportPayload,
      checklistData: overrides.checklistData || checklistData,
      completed: overrides.completed ?? false,
    };
    const coordinates = captured.checkInCoordinates;
    await saveVisitDraft({
      userId: user.id,
      clientVisitId: id,
      serverVisitId: captured.serverVisitId || null,
      agentId: captured.selectedAgent?.id,
      selectedAgent: captured.selectedAgent,
      agentLocation: captured.selectedAgent?.pendingLocation || null,
      tcLatitude: coordinates?.latitude,
      tcLongitude: coordinates?.longitude,
      gpsAccuracyMeters: coordinates?.accuracy,
      visitDate: coordinates?.timestamp || new Date().toISOString(),
      checkInTime: coordinates?.timestamp || new Date().toISOString(),
      gpsData: captured.gpsData,
      locationMethod: captured.locationMethod,
      currentStep: captured.currentStep,
      photoBlob: captured.photoFile || undefined,
      photoName: captured.photoFile?.name,
      photoType: captured.photoFile?.type,
      reportPayload: captured.reportPayload,
      checklistData: captured.checklistData,
      completed: captured.completed,
    });
  };

  const captureAgentLocation = () => {
    if (!selectedAgent) return;
    const incomingTransfer = selectedAgent.transfers?.find((transfer) => transfer.status === 'PENDING');
    if (incomingTransfer && !incomingTransfer.acceptedAt) {
      setError('The receiving TC must accept this transfer from the dashboard before recording the new location.');
      return;
    }
    const needsLocationCapture = Boolean(selectedAgent.registeredLatitude == null || selectedAgent.registeredLongitude == null || !selectedAgent.locationVerified || (!selectedAgent.firstVisitCompletedAt && !selectedAgent.firstVisitLocationCapturedAt));
    const transferNeedsLocationCapture = Boolean(incomingTransfer?.acceptedAt && needsLocationCapture);
    const locationAssignment = {
      territoryId: firstVisitFields.territoryId || selectedAgent.territoryId,
      sectorId: firstVisitFields.sectorId,
      cellId: firstVisitFields.cellId,
      cellName: firstVisitFields.cellName.trim(),
      villageId: firstVisitFields.villageId,
      villageName: firstVisitFields.villageName.trim(),
      venue: String(firstVisitFields.venue || '').trim(),
    };
    if (!locationAssignment.territoryId || !locationAssignment.sectorId || !locationAssignment.cellId || !locationAssignment.villageId) {
      setError('Select the district, sector, cell and village from the official territory lists before capturing the first-visit location.');
      return;
    }
    if (!locationAssignment.venue) {
      setError('Enter the agent’s venue before capturing the first-visit location.');
      return;
    }
    const saveLocation = async (capturedLocation) => {
      try {
        if (!navigator.onLine) throw new Error('OFFLINE');
        const captureUrl = isMoolaPlus
          ? `/api/v1/visits/moola-plus/agents/${encodeURIComponent(selectedAgent.id)}/location/capture`
          : `/api/v1/agents/${selectedAgent.id}/location/capture`;
        const { data } = await api.post(captureUrl, capturedLocation);
        setSelectedAgent(isMoolaPlus
          ? { ...selectedAgent, ...data, territory: { name: workTerritories.find((item) => item.id === data.territoryId)?.name || selectedAgent.territory?.name || '' }, pendingLocation: capturedLocation, locationSynced: true }
          : { ...data, pendingLocation: capturedLocation, locationSynced: true });
        setFirstVisitFields((current) => ({
          ...current,
          territoryId: data.territoryId || current.territoryId,
          sectorId: data.sectorId || current.sectorId,
          cellId: data.cellId || current.cellId,
          cellName: data.cell?.name || current.cellName,
          villageId: data.villageId || current.villageId,
          villageName: data.village?.name || current.villageName,
          venue: data.venue || locationAssignment.venue,
        }));
        setGpsStatus(null);
        setError(null);
      } catch (err) {
        if (!err.response && (err.message === 'OFFLINE' || !navigator.onLine)) {
          if (isMoolaPlus) setError('Moola Plus location capture needs a live connection so the saved coordinates can be verified. Reconnect and retry.');
          else if (capturedLocation.accuracy > 20) setError('GPS accuracy must be 20 m or better. Move to an open area and capture again.');
          else {
            setSelectedAgent({
              ...selectedAgent, ...locationAssignment, registeredLatitude: capturedLocation.latitude, registeredLongitude: capturedLocation.longitude,
              gpsAccuracy: capturedLocation.accuracy, locationVerified: true, venue: locationAssignment.venue,
              firstVisitLocationCapturedAt: selectedAgent.firstVisitLocationCapturedAt || new Date().toISOString(),
              pendingLocation: capturedLocation, locationSynced: false,
            });
            setGpsStatus(null);
            setError(null);
          }
        } else setError(err.response?.data?.error || 'Could not save the agent location. Try again in an open area.');
      } finally { setLocationCaptureLoading(false); }
    };
    if (selectedAgent.firstVisitLocationCapturedAt && !needsLocationCapture) {
      if (selectedAgent.registeredLatitude == null || selectedAgent.registeredLongitude == null || selectedAgent.gpsAccuracy == null) {
        setError('The saved location is incomplete. Ask a manager to correct the agent record.');
        return;
      }
      setLocationCaptureLoading(true);
      setError(null);
      saveLocation({ ...locationAssignment, latitude: selectedAgent.registeredLatitude, longitude: selectedAgent.registeredLongitude, accuracy: selectedAgent.gpsAccuracy });
      return;
    }
    if (!navigator.geolocation) { setError('This browser does not support GPS location.'); return; }
    setLocationCaptureLoading(true);
    setError(null);
    acquireBestLocation().then(async ({ coords }) => {
      const capturedLocation = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, ...locationAssignment };
      await saveLocation(capturedLocation);
    }).catch((err) => {
      setError(`Could not capture a fresh GPS reading: ${err.message}. Try near an open window or outside.`);
      setLocationCaptureLoading(false);
    });
  };

  const handleCheckIn = async () => {
    const stableId = clientVisitId || makeClientVisitId();
    let coordinates = null;
    let knownLocation = selectedAgent.pendingLocation || {
      latitude: selectedAgent.registeredLatitude,
      longitude: selectedAgent.registeredLongitude,
      accuracy: selectedAgent.gpsAccuracy,
    };
    setCheckInLoading(true);
    setGpsStatus('acquiring');
    setError(null);
    try {
      const position = await acquireBestLocation();
      coordinates = position ? {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: new Date(position.timestamp || Date.now()).toISOString(),
      } : null;
      if (isMoolaPlus && !navigator.onLine) throw new Error('Moola Plus visits need a live connection to check the upstream agent registry.');
      knownLocation = selectedAgent.pendingLocation || {
        latitude: selectedAgent.registeredLatitude,
        longitude: selectedAgent.registeredLongitude,
        accuracy: selectedAgent.gpsAccuracy,
      };
      if (!coordinates) throw new Error('Capture a fresh GPS reading before checking in.');
      if (!knownLocation || knownLocation.latitude == null || knownLocation.longitude == null || !selectedAgent.locationVerified) {
        throw new Error('Save and verify the agent’s coordinates before check-in. On a first visit, capture the agent’s location while you are there.');
      }
      if (coordinates.accuracy > 50) throw new Error(`GPS accuracy is ±${Math.round(coordinates.accuracy)} m. A reading of 50 m or better is required to check in.`);
      const localDistance = !coordinates || knownLocation.latitude == null || knownLocation.longitude == null
        ? null : distanceMeters(coordinates, { latitude: knownLocation.latitude, longitude: knownLocation.longitude });
      const localLocationStatus = !coordinates || coordinates.accuracy > 50
        ? 'LOW_ACCURACY'
        : localDistance > radiusMeters ? 'OUTSIDE_RADIUS' : 'VERIFIED';
      if (localLocationStatus !== 'VERIFIED') {
        throw new Error(localLocationStatus === 'OUTSIDE_RADIUS'
          ? `You are ${Math.round(localDistance)} m from the agent’s saved location. Check-in is allowed only within the configured ${radiusMeters} m radius.`
          : `GPS accuracy is too low (±${Math.round(coordinates.accuracy)} m). Get a clearer reading before checking in.`);
      }
      const localGpsData = {
        distance: localDistance == null ? null : Math.round(localDistance),
        radius: radiusMeters,
        accuracy: coordinates ? Math.round(coordinates.accuracy) : null,
        locationStatus: localLocationStatus,
        locationMethod: 'GPS',
        publicId: stableId,
      };
      const startLocally = async () => {
        if (!knownLocation || knownLocation.latitude == null || knownLocation.longitude == null) throw new Error('Capture the agent’s GPS location before starting this visit.');
        if (!selectedAgent.firstVisitCompletedAt && !String(selectedAgent.venue || '').trim()) throw new Error('Record the agent’s venue before starting the first visit.');
        if (!selectedAgent.firstVisitCompletedAt && !selectedAgent.firstVisitLocationCapturedAt && !selectedAgent.pendingLocation) throw new Error('Complete the first-visit district, sector, cell, village and GPS capture before starting this visit.');
        if (!selectedAgent.locationVerified && !selectedAgent.pendingLocation) throw new Error('This agent’s GPS location is not verified yet. Connect and refresh the agent package before starting an offline visit.');
        const id = stableId;
        setClientVisitId(id);
        setVisitId(id);
        setOfflineVisit(true);
        setLocationMethod('GPS');
        setCheckInCoordinates(coordinates);
        setGpsData(localGpsData);
        setMetricEligible(null);
        setGpsStatus('success');
        setCurrentStep(2);
        await persistDraft({ clientVisitId: id, serverVisitId: null, selectedAgent, checkInCoordinates: coordinates, gpsData: localGpsData, locationMethod: 'GPS', currentStep: 2 });
      };
      if (!navigator.onLine) {
        if (isMoolaPlus) throw new Error('Moola Plus visits need a live connection to check the upstream agent registry.');
        await startLocally();
        return;
      }
      let checkInAgent = selectedAgent;
      if (selectedAgent.pendingLocation && !selectedAgent.locationSynced) {
        const { data: updatedAgent } = await api.post(`/api/v1/agents/${selectedAgent.id}/location/capture`, selectedAgent.pendingLocation);
        checkInAgent = { ...updatedAgent, pendingLocation: selectedAgent.pendingLocation, locationSynced: true };
        setSelectedAgent(checkInAgent);
      }
      const checkInPayload = {
        visitId: stableId,
        ...(isMoolaPlus ? {
          externalAgentId: selectedAgent.id, territoryId: firstVisitFields.territoryId || workTerritoryId,
          sectorId: firstVisitFields.sectorId, cellId: firstVisitFields.cellId, villageId: firstVisitFields.villageId,
          venue: firstVisitFields.venue,
        } : { agentId: selectedAgent.id }),
        locationMethod: 'GPS',
        ...(coordinates ? { tcLatitude: coordinates.latitude, tcLongitude: coordinates.longitude, gpsAccuracyMeters: coordinates.accuracy } : {}),
      };
      const { data: visit } = isMoolaPlus
        ? await api.post('/api/v1/visits/moola-plus/check-in', checkInPayload)
        : await api.post('/api/v1/visits/check-in', checkInPayload);
      const nextGpsData = {
        distance: visit.distanceMeters == null ? null : Math.round(visit.distanceMeters),
        radius: visit.radiusMeters,
        accuracy: visit.gpsAccuracyMeters == null ? null : Math.round(visit.gpsAccuracyMeters),
        locationStatus: visit.locationStatus,
        locationMethod: visit.locationMethod,
        publicId: visit.visitId,
      };
      setClientVisitId(stableId);
      setVisitId(visit.id);
      setOfflineVisit(false);
      setLocationMethod('GPS');
      setCheckInCoordinates(coordinates);
      setGpsData(nextGpsData);
      setMetricEligible(visit.visitStatus === 'FLAGGED' ? false : null);
      setGpsStatus('success');
      setCurrentStep(2);
      await persistDraft({ clientVisitId: stableId, serverVisitId: visit.id, selectedAgent: checkInAgent, checkInCoordinates: coordinates, gpsData: nextGpsData, locationMethod: 'GPS', currentStep: 2 });
    } catch (err) {
      if (!err.response && (!navigator.onLine || err.message === 'Network Error')) {
        if (isMoolaPlus) {
          setGpsStatus('error');
          setError('The DDIN registry could not be reached. Retry when the service is available.');
        } else {
          try {
            if (!coordinates) throw err;
            if (knownLocation?.latitude == null || knownLocation?.longitude == null || !selectedAgent.locationVerified) throw new Error('Offline visits need a saved, verified agent location.');
            if (!selectedAgent.firstVisitCompletedAt && !String(selectedAgent.venue || '').trim()) throw new Error('Record the agent’s venue before saving the offline visit.');
            const fallbackDistance = coordinates ? distanceMeters(coordinates, knownLocation) : null;
            const localGpsData = {
              distance: fallbackDistance == null ? null : Math.round(fallbackDistance),
              radius: radiusMeters,
              accuracy: coordinates ? Math.round(coordinates.accuracy) : null,
              locationStatus: !coordinates || coordinates.accuracy > 50 ? 'LOW_ACCURACY' : fallbackDistance > radiusMeters ? 'OUTSIDE_RADIUS' : 'VERIFIED',
              locationMethod: 'GPS',
              publicId: stableId,
            };
            setClientVisitId(stableId); setVisitId(stableId); setOfflineVisit(true); setLocationMethod('GPS'); setCheckInCoordinates(coordinates); setGpsData(localGpsData); setMetricEligible(null); setGpsStatus('success'); setCurrentStep(2);
            await persistDraft({ clientVisitId: stableId, serverVisitId: null, selectedAgent, checkInCoordinates: coordinates, gpsData: localGpsData, locationMethod: 'GPS', currentStep: 2 });
          } catch (offlineError) { setGpsStatus('error'); setError(offlineError.message || 'Could not save this visit for offline sync.'); }
        }
      } else {
        setGpsStatus('error');
        setError(err.response?.data?.error || err.message || 'Failed to check in. Please try again.');
      }
    } finally {
      setCheckInLoading(false);
    }
  };

  const stopCamera = () => {
    cameraRequestRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is unavailable. Open this page over HTTPS on a device with a camera.');
      return;
    }

    setCameraLoading(true);
    const requestId = cameraRequestRef.current + 1;
    cameraRequestRef.current = requestId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (cameraRequestRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStreamRef.current = stream;
      setCameraActive(true);
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        setCameraError('Camera permission was denied. Allow camera access in your browser settings, then try again.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setCameraError('No camera is available on this device.');
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        setCameraError('The camera is already in use. Close other camera apps and try again.');
      } else {
        setCameraError('Could not open the camera. Check camera access and try again.');
      }
    } finally {
      setCameraLoading(false);
    }
  };

  const captureCameraPhoto = () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setCameraError('The camera is still starting. Wait a moment and try again.');
      return;
    }

    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        setCameraError('Could not capture this photo. Try again.');
        return;
      }
      const file = new File([blob], `visit-evidence-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
      setCameraError('');
      stopCamera();
    }, 'image/jpeg', 0.82);
  };

  const retakePhoto = () => {
    setPhotoFile(null);
    setPhotoPreview(null);
    startCamera();
  };

  const handleSavePhoto = async () => {
    if (!photoFile) return;
    setPhotoLoading(true);
    setPhotoUploadStage(offlineVisit || !navigator.onLine ? 'saving-local' : 'uploading');
    setPhotoUploadProgress(offlineVisit || !navigator.onLine ? null : 0);
    try {
      if (offlineVisit || !navigator.onLine) {
        await persistDraft({ photoFile, currentStep: 3 });
        setCurrentStep(3);
        return;
      }
      const formData = new FormData();
      formData.append('photo', photoFile);
      await api.put(`/api/v1/visits/${visitId}/photo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: ({ loaded, total }) => {
          if (total) setPhotoUploadProgress(Math.min(100, Math.round((loaded / total) * 100)));
        },
      });
      setPhotoUploadStage('saving-local');
      await persistDraft({ photoFile, currentStep: 3 });
      setCurrentStep(3);
    } catch (err) {
      if (!err.response && !navigator.onLine) {
        try { setPhotoUploadStage('saving-local'); await persistDraft({ photoFile, currentStep: 3 }); setCurrentStep(3); }
        catch (saveError) { setError(saveError.message || 'Could not save this photo on the device. Free up storage and try again.'); }
      } else {
        const message = err.response?.data?.error || 'Failed to save photo. Please try again.';
        const requestId = err.response?.headers?.['x-request-id'];
        setError(requestId ? `${message} Request ID: ${requestId}` : message);
      }
    } finally {
      setPhotoLoading(false);
      setPhotoUploadStage('');
      setPhotoUploadProgress(null);
    }
  };

  const handleSubmitReport = async () => {
    const missingConfiguredRequired = !isMoolaPlus && withoutDuplicateVisitQuestions(checklist)
      .some((item) => item.section === 'IREMBO' && !String(checklistData[item.id] ?? '').trim());
    if (missingConfiguredRequired) {
      setError('Complete every required question configured by an administrator before submitting.');
      return;
    }
    setError(null);
    setReportLoading(true);
    try {
      const configuredAnswers = Object.fromEntries(withoutDuplicateVisitQuestions(checklist)
        .filter((item) => String(checklistData[item.id] ?? '').trim() !== '')
        .map((item) => [item.id, { question: item.text, answer: checklistData[item.id] }]));
      const reportPayload = {
        checklistData: configuredAnswers,
      };
      setSavedReportPayload(reportPayload);
      if (offlineVisit || !navigator.onLine) {
        await persistDraft({ reportPayload, currentStep: 4 });
        setCurrentStep(4);
        return;
      }
      await api.post(`/api/v1/visits/${visitId}/report`, reportPayload);
      await persistDraft({ reportPayload, currentStep: 4 });
      setCurrentStep(4);
    } catch (err) {
      if (!err.response && !navigator.onLine) {
        const configuredAnswers = Object.fromEntries(withoutDuplicateVisitQuestions(checklist)
          .filter((item) => String(checklistData[item.id] ?? '').trim() !== '')
          .map((item) => [item.id, { question: item.text, answer: checklistData[item.id] }]));
        const reportPayload = savedReportPayload || {
          checklistData: configuredAnswers,
        };
        try { setSavedReportPayload(reportPayload); await persistDraft({ reportPayload, currentStep: 4 }); setCurrentStep(4); }
        catch (saveError) { setError(saveError.message || 'Could not save the report on this device.'); }
      } else setError(err.response?.data?.error || 'Failed to submit report.');
    } finally {
      setReportLoading(false);
    }
  };

  const handleCompleteVisit = async () => {
    setCheckOutLoading(true);
    try {
      if (offlineVisit || !navigator.onLine) {
        await persistDraft({ completed: true, currentStep: 4 });
        setCompletionResult({ visitStatus: 'PENDING_SYNC', visitId: clientVisitId });
        setVisitCompleted(true);
        return;
      }
      const response = await api.put(`/api/v1/visits/${visitId}/check-out`);
      setCompletionResult(response.data);
      setMetricEligible(Boolean(response.data.countsForMetrics));
      setVisitCompleted(true);
      await persistDraft({ completed: true, currentStep: 4 });
    } catch (err) {
      if (!err.response && !navigator.onLine) {
        try {
          await persistDraft({ completed: true, currentStep: 4 });
          setCompletionResult({ visitStatus: 'PENDING_SYNC', visitId: clientVisitId });
          setVisitCompleted(true);
        } catch (saveError) { setError(saveError.message || 'Could not save the completed visit on this device.'); }
      } else setError(err.response?.data?.error || 'Failed to complete visit.');
    } finally {
      setCheckOutLoading(false);
    }
  };

  const workTerritories = offlinePack?.territories || [];
  const workDistrict = workTerritories.find((territory) => territory.id === workTerritoryId) || workTerritories[0];
  const activePlan = browseMode === 'PLAN' ? plans.find((plan) => plan.id === selectedPlanId) : null;
  const activePlanArea = activePlan?.territory?.name || 'Selected territory';
  const activePlanStart = activePlan ? String(activePlan.planDate).slice(0, 10) : '';
  const activePlanEnd = activePlan ? String(activePlan.endDate || activePlan.planDate).slice(0, 10) : '';
  const workSectors = workDistrict?.children || [];
  const workCells = workSectors.flatMap((sector) => sector.children || []);
  const workVillages = workCells.flatMap((cell) => cell.children || []);
  const locationDistrictId = firstVisitFields.territoryId || selectedAgent?.transfers?.find((transfer) => transfer.status === 'PENDING')?.toTerritoryId || selectedAgent?.territoryId;
  const locationDistrict = workTerritories.find((territory) => territory.id === locationDistrictId);
  const locationSectors = locationDistrict?.children || [];
  const locationSector = locationSectors.find((sector) => sector.id === firstVisitFields.sectorId);
  const locationCells = locationSector?.children || [];
  const locationCell = locationCells.find((cell) => cell.id === firstVisitFields.cellId);
  const locationVillages = locationCell?.children || [];
  const toggleAreaSelection = (current, setter, id) => setter(current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  const openTransferPanel = async () => {
    if (transferPanelOpen) { setTransferPanelOpen(false); return; }
    setTransferPanelOpen(true);
    if (transferTargets.length || !selectedAgent) return;
    try {
      const { data } = await api.get(`/api/v1/agents/${selectedAgent.id}/transfer-targets`);
      setTransferTargets(data || []);
      setTransferTargetsLoaded(true);
      if (data?.length) {
        setTransferTargetId(data[0].id);
        setTransferRecipientId(data[0].coordinators?.[0]?.id || '');
      }
    } catch (err) { setTransferTargetsLoaded(true); setError(err.response?.data?.error || 'Could not load destination coordinators.'); }
  };

  const submitTransferRequest = async () => {
    if (!selectedAgent || !transferTargetId || !transferRecipientId) { setError('Choose the destination district and its coordinator.'); return; }
    setTransferLoading(true);
    setError(null);
    try {
      const { data } = await api.post(`/api/v1/agents/${selectedAgent.id}/transfer`, {
        toTerritoryId: transferTargetId, recipientTcId: transferRecipientId, reason: transferReason.trim(),
      });
      setTransferRequested(true);
      setSelectedAgent((current) => ({ ...current, transferRequest: data }));
    } catch (err) { setError(err.response?.data?.error || 'Could not send the transfer request.'); }
    finally { setTransferLoading(false); }
  };

  const renderAreaFilters = (label, items, selected, setter) => items.length ? <details className="rounded-lg border border-gray-200 bg-white px-3 py-2">
    <summary className="cursor-pointer text-sm font-medium text-gray-700">{label} <span className="text-gray-500">({selected.length || 'all'})</span></summary>
    <div className="mt-2 grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
      {items.map((item) => <label key={item.id} className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm text-gray-700 hover:bg-gray-50">
        <input type="checkbox" checked={selected.includes(item.id)} onChange={() => { toggleAreaSelection(selected, setter, item.id); setAgentPage(1); }} />
        <span>{item.name}</span>
      </label>)}
    </div>
  </details> : null;

  const activeIncomingTransfer = selectedAgent?.transfers?.find((transfer) => transfer.status === 'PENDING');
  const waitingForTransferReview = Boolean(activeIncomingTransfer && !activeIncomingTransfer.acceptedAt);
  const needsLocationCapture = Boolean(selectedAgent && (selectedAgent.registeredLatitude == null || selectedAgent.registeredLongitude == null || !selectedAgent.locationVerified || (!selectedAgent.firstVisitCompletedAt && !selectedAgent.firstVisitLocationCapturedAt)));
  const transferNeedsLocationCapture = Boolean(activeIncomingTransfer?.acceptedAt && needsLocationCapture);
  const showLocationCapture = Boolean(selectedAgent && !isMoolaPlus && (!selectedAgent.firstVisitCompletedAt || needsLocationCapture));
  const showMoolaLocationCapture = Boolean(isMoolaPlus && selectedAgent && (
    !selectedAgent.locationVerified || selectedAgent.registeredLatitude == null || selectedAgent.registeredLongitude == null
    || !firstVisitFields.sectorId || !firstVisitFields.cellId || !firstVisitFields.villageId || !firstVisitFields.venue.trim()
  ));
  const moolaLocationReady = Boolean(selectedAgent?.locationVerified && selectedAgent?.registeredLatitude != null && selectedAgent?.registeredLongitude != null && firstVisitFields.sectorId && firstVisitFields.cellId && firstVisitFields.villageId && firstVisitFields.venue.trim());
  const relocationNeedsLocationCapture = Boolean(needsLocationCapture && selectedAgent?.firstVisitCompletedAt && !transferNeedsLocationCapture);

  if (visitCompleted) {
    const pendingSync = completionResult?.visitStatus === 'PENDING_SYNC';
    return (
      <div className="max-w-2xl mx-auto mt-10 p-6 bg-white rounded-lg border border-gray-200 shadow-sm text-center">
        <CheckCircle className="w-16 h-16 text-green-600 mx-auto mb-4" />
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">{pendingSync ? 'Visit saved on this device' : completionResult?.visitStatus === 'FLAGGED' ? 'Visit submitted for review' : 'Visit completed'}</h2>
        <p className="text-gray-600 mb-6">{pendingSync ? 'It will upload automatically when this device reconnects. Keep this browser data until it syncs.' : `Visit ID: ${completionResult?.visitId || gpsData?.publicId}`}</p>
        <button 
          onClick={() => navigate(pendingSync ? '/visits' : `/visits/${visitId}`)}
          className="btn btn-primary"
        >
          {pendingSync ? 'Back to visits' : 'View Details'}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20">
      {workloadOpen && workload && currentStep === 0 && (
        <div className="field-workload-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWorkloadOpen(false); }}>
          <section className="field-workload-dialog" role="dialog" aria-modal="true" aria-labelledby="field-workload-title">
            <span className="field-workload-kicker"><CalendarDays size={15} /> TODAY’S FIELD WORK</span>
            <h2 id="field-workload-title">Your priority list is ready</h2>
            <p>Today’s target is {workload.dailyTarget} agents{workload.carryOver ? `, plus ${workload.carryOver} carried from earlier weekdays` : ''}. You have completed {workload.completedToday} eligible visits today.</p>
            <div className="field-workload-counts"><strong>{workload.remainingTarget}</strong><span>more agents to cover today</span></div>
            {workload.dueAgents?.length > 0 && <ul>{workload.dueAgents.slice(0, 5).map((agent) => <li key={agent.id}><span>{agent.name}</span><small>{agent.agentId} · {agent.territory?.name || 'Assigned territory'}</small></li>)}</ul>}
            {workload.dueCount === 0 && <p className="field-workload-clear">Your eligible visits are up to date for today.</p>}
            <div className="field-workload-actions">
              {workload.dueCount > 0 && <button type="button" className="btn btn-primary" onClick={() => {
                setBrowseMode('MANUAL'); setSelectedPlanId(''); setWorkTerritoryId(''); setWorkSectorIds([]); setWorkCellIds([]); setWorkVillageIds([]); setPriorityOnly(true); setAgentPage(1); setWorkloadOpen(false);
              }}>Show priority agents</button>}
              <button type="button" className="btn btn-secondary" onClick={() => {
                try { window.localStorage.setItem(`field-workload-dismissed-${user?.id}-${workload.date}`, '1'); } catch { /* The popup can still be dismissed for this session. */ }
                setWorkloadOpen(false);
              }}>Continue to field plans</button>
            </div>
          </section>
        </div>
      )}
      {/* Stepper */}
      <div className="visit-workflow-stepper bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
        <div className="hidden md:flex justify-between relative">
          <div className="absolute top-4 left-0 w-full h-0.5 bg-gray-200 -z-10" />
          <div className="absolute top-4 left-0 h-0.5 bg-[#202a4e] -z-10 transition-all duration-300" 
               style={{ width: `${(currentStep / (STEPS.length - 1)) * 100}%` }} />
          {STEPS.map((step, idx) => (
            <div key={idx} className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold mb-2 
                ${idx <= currentStep ? 'bg-[#202a4e] text-white' : 'bg-gray-100 text-gray-400 border border-gray-300'}`}>
                {idx + 1}
              </div>
              <span className={`text-xs ${idx <= currentStep ? 'text-gray-900 font-medium' : 'text-gray-500'}`}>
                {step}
              </span>
            </div>
          ))}
        </div>
        <div className="md:hidden flex items-center justify-between">
          <span className="font-semibold text-[#202a4e]">Step {currentStep + 1}: {STEPS[currentStep]}</span>
          <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-[#202a4e]" style={{ width: `${((currentStep + 1) / STEPS.length) * 100}%` }} />
          </div>
        </div>
      </div>

      {error && currentStep !== 1 && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-md flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-700 font-bold">&times;</button>
        </div>
      )}

      {/* STEP 1: Select Agent */}
      {currentStep === 0 && (
        <div className="visit-agent-selection">
          <section className="visit-route-card">
            <div className="visit-route-heading"><div><span className="section-kicker">TODAY’S ROUTE</span><h2>{activePlan ? activePlanArea : priorityOnly ? 'Priority agents' : 'Choose how to work'}</h2><p>{isMoolaPlus ? 'Choose an assigned district. The agent list comes from the current DDIN Moola Plus registry.' : activePlan ? `Agents from your saved plan · ${activePlanStart} to ${activePlanEnd}` : priorityOnly ? 'Agents with the oldest outstanding coverage are listed first.' : 'Choose a saved plan or browse your assigned areas directly.'}</p></div></div>
            {!isMoolaPlus && <div className="visit-plan-picker">
              <label htmlFor="visit-field-plan">Saved field plan</label>
              <select id="visit-field-plan" className="form-select" value={activePlan?.id || ''} onChange={(event) => {
                if (event.target.value) { setBrowseMode('PLAN'); setSelectedPlanId(event.target.value); setPriorityOnly(false); }
                else { setBrowseMode('MANUAL'); setSelectedPlanId(''); setPriorityOnly(false); setAgentPage(1); }
              }}>
                <option value="">Browse without a plan</option>
                {plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.territory?.name || 'Territory'} · {String(plan.planDate).slice(0, 10)}–{String(plan.endDate || plan.planDate).slice(0, 10)} · target {plan.targetAgents}</option>)}
              </select>
              {plans.length === 0 && <small>No active plan is saved for today. You can browse your assigned areas or create a plan for another day.</small>}
            </div>}
            {activePlan && <div className="visit-plan-summary"><span><strong>Target</strong>{activePlan.targetAgents} agents</span><span><strong>Minimum</strong>{activePlan.minimumAgents || 0} agents</span><span><strong>Estimated area time</strong>{activePlan.estimatedWorkingDays || 0} weekdays</span><button type="button" onClick={() => { setBrowseMode('MANUAL'); setSelectedPlanId(''); setAgentPage(1); }}>Browse without this plan</button></div>}
            {priorityOnly && <div className="visit-priority-mode"><span>Showing today’s due list across your assigned territories.</span><button type="button" onClick={() => { setPriorityOnly(false); setAgentPage(1); }}>Show all assigned agents</button></div>}
            {!activePlan && !priorityOnly && <>
              <label className="visit-route-field" htmlFor="visit-work-territory">District</label>
              <select id="visit-work-territory" className="form-select visit-route-district" value={workTerritoryId || workDistrict?.id || ''} onChange={(event) => {
                setWorkTerritoryId(event.target.value); setWorkSectorIds([]); setWorkCellIds([]); setWorkVillageIds([]); setAgentPage(1);
              }}>
                {workTerritories.map((territory) => <option value={territory.id} key={territory.id}>{territory.name}</option>)}
              </select>
              {!workTerritories.length && <p className="text-sm text-amber-800">Connect to refresh your assigned territories before planning the day.</p>}
              {!isMoolaPlus && <div className="visit-route-filters">
                {renderAreaFilters('Sectors', workSectors, workSectorIds, setWorkSectorIds)}
                {renderAreaFilters('Cells', workCells, workCellIds, setWorkCellIds)}
                {renderAreaFilters('Villages', workVillages, workVillageIds, setWorkVillageIds)}
              </div>}
            </>}
          </section>
          <div className="visit-agent-list-heading">
            <div><h2>Choose the agent you are visiting</h2><p>{isMoolaPlus ? 'Select a Moola Plus agent to start a visit.' : 'Select an active agent to start the visit record.'}</p></div>
            <span>{agentsLoading ? 'Loading agents' : `${agentTotal} ${agentTotal === 1 ? 'agent' : 'agents'}`}</span>
          </div>
          <label className="visit-agent-search">
            <Search aria-hidden="true" />
            <input 
              type="text"
              placeholder={`Search ${isMoolaPlus ? 'Moola Plus' : 'Irembo'} agent by name, phone, ID, or business...`}
              aria-label={`Search ${isMoolaPlus ? 'Moola Plus' : 'Irembo'} agents`}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setAgentPage(1); }}
            />
          </label>
          <div className="visit-agent-results">
            {agentsLoading && <div className="visit-agent-message">Loading assigned agents…</div>}
            {!agentsLoading && agents.map(agent => (
              <button
                key={agent.id}
                type="button"
                onClick={() => handleAgentSelect(agent)}
                className={`visit-agent-card${coverageIsActive(agent) ? ' is-covered' : ''}`}
              >
                <div className="visit-agent-card-main">
                  <div className="visit-agent-card-meta">
                    <span className="visit-agent-id">{agent.agentId}</span>
                    {coverageIsActive(agent) && <span className="visit-agent-covered"><Check size={14} aria-hidden="true" />Visited in this 3-month period</span>}
                    {agent.overdue && <span className="visit-agent-overdue">Visit overdue</span>}
                    {agent.transfers?.some((transfer) => transfer.status === 'PENDING') && <span className="visit-agent-overdue">Incoming transfer</span>}
                  </div>
                  <h3>{agent.name}</h3>
                  <p className="visit-agent-business">{agent.businessName || 'Independent agent'}{agent.moolaPlus ? ` · ${agent.activityStatus}` : ''}</p>
                  {agent.phoneNumber && <p className="visit-agent-phone"><Phone aria-hidden="true" /><span>{agent.phoneNumber}</span></p>}
                  <div className="visit-agent-location"><MapPin aria-hidden="true" /><span>{agent.address || 'Location not recorded'}</span></div>
                  {agent.last_visit_date && (
                    <p className="visit-agent-last-visit">{agent.overdue ? 'Last visited' : 'Previous visit'}: {agent.last_visit_date}</p>
                  )}
                </div>
                <span className="visit-agent-action">Select <ArrowRight aria-hidden="true" /></span>
              </button>
            ))}
            {!agentsLoading && agents.length === 0 && !error && (
              <div className="visit-agent-message">No active agents match that search.</div>
            )}
          </div>
          {!agentsLoading && agentTotal > 0 && <ListPagination
            page={agentPage}
            pages={agentPages}
            total={agentTotal}
            pageSize={agentPageSize}
            onPageChange={setAgentPage}
            onPageSizeChange={(value) => { setAgentPageSize(value); setAgentPage(1); }}
          />}
        </div>
      )}

      {/* STEP 2: GPS Check-In */}
      {currentStep === 1 && selectedAgent && (
        <div className="visit-workflow-step space-y-6">
          <button onClick={() => setCurrentStep(0)} className="text-[#202a4e] font-medium flex items-center mb-2 hover:underline">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to selection
          </button>
          
          <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
            <h3 className="font-semibold text-lg">{selectedAgent.name}</h3>
            <p className="text-gray-600">{selectedAgent.businessName || 'Independent agent'}</p>
            {selectedAgent.phoneNumber && <p className="visit-agent-phone"><Phone size={15} aria-hidden="true" /><a href={`tel:${selectedAgent.phoneNumber.replace(/[^\d+]/g, '')}`}>Call {selectedAgent.phoneNumber}</a></p>}
            <p className="text-sm text-gray-500 mt-1 flex items-center"><MapPin className="w-4 h-4 mr-1"/> {selectedAgent.address}</p>
          </div>

          {waitingForTransferReview && <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950"><h3 className="font-semibold">Transfer awaiting your review</h3><p className="mt-1 text-sm">Open the dashboard notification, call the agent, and confirm they are in your district before accepting. You cannot visit or record their location yet.</p><button type="button" className="btn btn-secondary mt-3" onClick={() => navigate('/dashboard')}>Open dashboard requests</button></div>}
          {isMoolaPlus && selectedAgent.moolaPendingRelocation && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>Relocation request awaiting review</strong><p className="mt-1">You can resume visits after an administrator reviews the destination district.</p></div>}
          {isMoolaPlus && !selectedAgent.moolaPendingRelocation && <div className="rounded-xl border border-[#d8e3dc] bg-[#f4f7f4] p-4 text-sm text-[#354b3e]"><strong>{selectedAgent.locationVerified ? 'Saved Moola Plus location' : 'First visit or relocated location'}</strong><p className="mt-1">{selectedAgent.locationVerified ? 'Check in is compared with this saved field GPS.' : 'Choose the agent’s official area and venue. A precise GPS reading at check-in saves the location; uncertain readings are held for review.'}</p></div>}
          {showMoolaLocationCapture && !selectedAgent.moolaPendingRelocation && <div className="first-visit-location-panel">
            <div className="first-visit-location-intro"><span className="first-visit-location-mark"><MapPin size={18} aria-hidden="true" /></span><div><span className="first-visit-location-kicker">MOOLA PLUS FIELD LOCATION</span><h3>Set the agent’s area and venue</h3><p>Choose the official district, sector, cell and village. GPS is captured with this check-in.</p></div></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">District<select className="form-select mt-1 w-full" value={firstVisitFields.territoryId} onChange={(event) => setFirstVisitFields((current) => ({ ...current, territoryId: event.target.value, sectorId: '', cellId: '', cellName: '', villageId: '', villageName: '' }))}><option value="">Choose district</option>{workTerritories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="text-sm font-medium text-gray-700">Sector<select className="form-select mt-1 w-full" value={firstVisitFields.sectorId} onChange={(event) => setFirstVisitFields((current) => ({ ...current, sectorId: event.target.value, cellId: '', cellName: '', villageId: '', villageName: '' }))} disabled={!locationDistrict}><option value="">Choose sector</option>{locationSectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="text-sm font-medium text-gray-700">Cell<select className="form-select mt-1 w-full" value={firstVisitFields.cellId} onChange={(event) => { const cell = locationCells.find((item) => item.id === event.target.value); setFirstVisitFields((current) => ({ ...current, cellId: cell?.id || '', cellName: cell?.name || '', villageId: '', villageName: '' })); }} disabled={!locationSector}><option value="">Choose cell</option>{locationCells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="text-sm font-medium text-gray-700">Village<select className="form-select mt-1 w-full" value={firstVisitFields.villageId} onChange={(event) => { const village = locationVillages.find((item) => item.id === event.target.value); setFirstVisitFields((current) => ({ ...current, villageId: village?.id || '', villageName: village?.name || '' })); }} disabled={!locationCell}><option value="">Choose village</option>{locationVillages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">Venue<input className="form-select mt-1 w-full" type="text" value={firstVisitFields.venue} onChange={(event) => setFirstVisitFields((current) => ({ ...current, venue: event.target.value }))} placeholder="Market, building or business centre" maxLength={200} required /></label>
            </div>
          </div>}
          {transferRequested ? <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-green-900">
            <h3 className="font-semibold">Transfer request sent</h3>
            <p className="mt-1 text-sm">The coordinator in the destination district will assign the new village and record the agent’s location at the first visit.</p>
            <button type="button" className="btn btn-secondary mt-4" onClick={() => navigate('/visits')}>Return to visits</button>
          </div> : <div className="space-y-4">
            {showLocationCapture && !waitingForTransferReview && <div className="first-visit-location-panel">
              <div className="first-visit-location-intro">
                <span className="first-visit-location-mark"><MapPin size={18} aria-hidden="true" /></span>
                <div>
                  <span className="first-visit-location-kicker">{transferNeedsLocationCapture ? 'TRANSFER LOCATION CHECK' : relocationNeedsLocationCapture ? 'RELOCATED AGENT LOCATION CHECK' : 'ONE-TIME FIELD RECORD'}</span>
                  <h3>{transferNeedsLocationCapture ? 'Record the agent’s location in your district' : relocationNeedsLocationCapture ? 'Verify the agent’s new location' : 'Set the agent’s first-visit location'}</h3>
                  <p>{transferNeedsLocationCapture ? 'The transfer is accepted. Choose the agent’s current sector, cell and village, enter the venue, and capture a fresh GPS location while you are with them.' : relocationNeedsLocationCapture ? 'This agent has moved. Confirm the sector, cell and village, update the venue if needed, then capture a fresh GPS location during this visit before check-in.' : 'Choose a saved cell or village, enter the agent’s venue, then capture the location. New areas are saved under the selected parent when GPS is captured; the territory and GPS are then locked.'}</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm font-medium text-gray-700">District
                  <select className="form-select mt-1 w-full" value={firstVisitFields.territoryId} disabled={!needsLocationCapture} onChange={(event) => setFirstVisitFields((current) => ({ ...current, territoryId: event.target.value, sectorId: '', cellId: '', cellName: '', villageId: '', villageName: '' }))}>
                    <option value="">Choose district</option>{workTerritories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="text-sm font-medium text-gray-700">Sector
                  <select className="form-select mt-1 w-full" value={firstVisitFields.sectorId} disabled={!needsLocationCapture} onChange={(event) => setFirstVisitFields((current) => ({ ...current, sectorId: event.target.value, cellId: '', cellName: '', villageId: '', villageName: '' }))}>
                    <option value="">Choose sector</option>{locationSectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <div className="first-visit-area-field">
                  <div className="first-visit-area-heading"><label htmlFor="first-visit-cell">Cell</label><span>{locationCells.length ? `${locationCells.length} available` : 'None available'}</span></div>
                  <select id="first-visit-cell" aria-describedby="first-visit-cell-hint" className="form-select mt-1 w-full" value={firstVisitFields.cellId} disabled={!needsLocationCapture || !locationSector || !locationCells.length} onChange={(event) => { const cell = locationCells.find((item) => item.id === event.target.value); setFirstVisitFields((current) => ({ ...current, cellId: cell?.id || '', cellName: cell?.name || '', villageId: '', villageName: '' })); }}>
                    <option value="">Choose an official cell</option>{locationCells.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <p id="first-visit-cell-hint" className="first-visit-area-hint">Choose a saved cell. Manual territory entry is disabled to prevent duplicate names.</p>
                </div>
                <div className="first-visit-area-field">
                  <div className="first-visit-area-heading"><label htmlFor="first-visit-village">Village</label><span>{locationVillages.length ? `${locationVillages.length} available` : 'None available'}</span></div>
                  <select id="first-visit-village" aria-describedby="first-visit-village-hint" className="form-select mt-1 w-full" value={firstVisitFields.villageId} disabled={!needsLocationCapture || !firstVisitFields.cellId || !locationVillages.length} onChange={(event) => { const village = locationVillages.find((item) => item.id === event.target.value); setFirstVisitFields((current) => ({ ...current, villageId: village?.id || '', villageName: village?.name || '' })); }}>
                    <option value="">Choose an official village</option>{locationVillages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <p id="first-visit-village-hint" className="first-visit-area-hint">Choose a saved village from the selected cell.</p>
                </div>
                <label className="text-sm font-medium text-gray-700">Venue
                  <input className="form-select mt-1 w-full" type="text" value={firstVisitFields.venue} onChange={(event) => setFirstVisitFields((current) => ({ ...current, venue: event.target.value }))} placeholder="Market, building or business centre" maxLength={200} required />
                  <span className="first-visit-area-hint">Enter the place name people use to identify this agent’s location.</span>
                </label>
              </div>
              {selectedAgent.firstVisitLocationCapturedAt && !needsLocationCapture ? <><p className="mt-3 text-sm font-medium text-green-800">The territory and GPS capture are locked.</p><button onClick={captureAgentLocation} disabled={locationCaptureLoading || selectedAgent.firstVisitCompletedAt || !firstVisitFields.venue.trim() || firstVisitFields.venue.trim() === String(selectedAgent.venue || '').trim()} className="btn btn-secondary mt-3 w-full justify-center disabled:opacity-50" type="button">
                <MapPin size={17} />{locationCaptureLoading ? 'Saving venue…' : 'Save venue'}
              </button></> : <button onClick={captureAgentLocation} disabled={locationCaptureLoading || !locationSector || !firstVisitFields.cellId || !firstVisitFields.villageId || !firstVisitFields.venue.trim()} className="btn btn-primary mt-4 w-full justify-center disabled:opacity-50" type="button">
                <MapPin size={17} />{locationCaptureLoading ? 'Capturing precise location…' : transferNeedsLocationCapture ? 'Capture new transfer location' : relocationNeedsLocationCapture ? 'Capture relocated location' : 'Capture first-visit location'}
              </button>}
              {!selectedAgent.firstVisitLocationCapturedAt && !selectedAgent.transfers?.some((transfer) => transfer.status === 'PENDING') && !selectedAgent.transferRequest && <div className="mt-4 border-t border-[#e5e8ef] pt-3">
                <button type="button" className="text-sm font-semibold text-[#202a4e] underline" onClick={openTransferPanel}>The agent moved to another district?</button>
                {transferPanelOpen && <div className="mt-3 space-y-3 rounded-lg border border-amber-200 bg-white p-3">
                  {!transferTargetsLoaded ? <p className="text-sm text-gray-600">Loading destination districts…</p> : !transferTargets.length ? <p className="text-sm text-gray-600">No active TC is assigned to another district yet.</p> : <>
                    <label className="block text-sm font-medium text-gray-700">Destination district
                      <select className="form-select mt-1 w-full" value={transferTargetId} onChange={(event) => {
                        const targetId = event.target.value;
                        const target = transferTargets.find((item) => item.id === targetId);
                        setTransferTargetId(targetId); setTransferRecipientId(target?.coordinators?.[0]?.id || '');
                      }}>
                        {transferTargets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.province ? ` — ${item.province}` : ''}</option>)}
                      </select>
                    </label>
                    <label className="block text-sm font-medium text-gray-700">Coordinator to receive the agent
                      <select className="form-select mt-1 w-full" value={transferRecipientId} onChange={(event) => setTransferRecipientId(event.target.value)}>
                        {(transferTargets.find((item) => item.id === transferTargetId)?.coordinators || []).map((tc) => <option key={tc.id} value={tc.id}>{[tc.firstName, tc.lastName].filter(Boolean).join(' ')}</option>)}
                      </select>
                    </label>
                    <label className="block text-sm font-medium text-gray-700">Relocation note
                      <textarea className="form-input mt-1 w-full" rows={2} value={transferReason} onChange={(event) => setTransferReason(event.target.value)} placeholder="Where the agent relocated, if known" />
                    </label>
                    <button type="button" className="btn btn-primary w-full justify-center" onClick={submitTransferRequest} disabled={transferLoading || !transferTargets.length}>{transferLoading ? 'Sending request…' : 'Send transfer request'}</button>
                  </>}
                </div>}
              </div>}
            </div>}
            {selectedAgent.firstVisitCompletedAt && selectedAgent.registeredLatitude != null && selectedAgent.registeredLongitude != null && !selectedAgent.locationVerified && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">This saved agent location still needs verification. Refresh the field package while connected before recording a visit.</div>
            )}
            {gpsStatus === 'acquiring' && (
              <div className="bg-blue-50 text-blue-700 p-4 rounded-md flex items-center border border-blue-200">
                <RefreshCw className="w-5 h-5 mr-3 animate-spin" /> Locating you...
              </div>
            )}
            {gpsStatus === 'success' && gpsData && gpsData.locationStatus === 'VERIFIED' && (
              <div className="bg-green-50 text-green-700 p-4 rounded-md flex items-start border border-green-200">
                <CheckCircle className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0" />
                <div>GPS verified — {gpsData.distance}m from the saved agent location (within {gpsData.radius}m radius).</div>
              </div>
            )}
            {gpsStatus === 'success' && gpsData && (
              <div className={`metric-eligibility-note ${metricEligible === false ? 'is-excluded' : ''}`} role="status">
                {metricEligible === null
                  ? offlineVisit ? 'Saved offline. The server will determine metric eligibility after this visit syncs and is completed.' : 'Coverage eligibility is calculated when the visit is completed.'
                  : metricEligible
                    ? 'This visit is eligible for the agent’s current three-month metric window. Coverage and activity charts include it after completion.'
                    : locationMethod === 'MANUAL_EVIDENCE' || gpsData.locationStatus !== 'VERIFIED'
                      ? 'This visit is held for location review and will not count unless an administrator approves it.'
                      : 'This repeat visit stays in visit history but does not affect coverage or performance metrics.'}
              </div>
            )}

            <button
              onClick={() => handleCheckIn()}
              disabled={checkInLoading || waitingForTransferReview || Boolean(isMoolaPlus && selectedAgent.moolaPendingRelocation) || gpsStatus === 'success' || (isMoolaPlus ? !(firstVisitFields.territoryId || workTerritoryId) || !moolaLocationReady : selectedAgent.registeredLatitude == null || selectedAgent.registeredLongitude == null || (!selectedAgent.locationVerified && !selectedAgent.pendingLocation) || (!selectedAgent.firstVisitCompletedAt && !selectedAgent.firstVisitLocationCapturedAt && !selectedAgent.pendingLocation))}
              className="btn btn-primary w-full justify-center py-4 text-base disabled:opacity-50"
            >
              <MapPin className="w-6 h-6 mr-2" />
              {checkInLoading ? 'Checking in...' : (gpsStatus === 'success' ? 'Checked In' : 'Check In')}
            </button>
            {error && currentStep === 1 && <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-md" role="alert">{error}</div>}
            <p className="metric-policy-note">A check-in needs a fresh GPS reading inside the administrator’s radius around the agent’s saved coordinates. The visit cannot continue without that verification.</p>
            <p className="metric-policy-note">You can record repeat visits. Only one visit per agent in a rolling three-month period counts toward coverage and performance metrics.</p>
          </div>}
        </div>
      )}

      {/* STEP 3: Camera Capture */}
      {currentStep === 2 && (
        <div className="visit-workflow-step camera-capture-step">
          {gpsData && (
            <div className={`camera-location-status ${gpsData.locationStatus === 'VERIFIED' ? 'is-verified' : 'is-review'}`}>
              <span>Location status</span><strong>{gpsData.locationStatus === 'VERIFIED' ? 'Verified' : 'Review required'}</strong><small>{gpsData.distance == null ? 'No check-in GPS reading' : `${gpsData.distance} m from registered location`}</small>
            </div>
          )}

          <div className="camera-capture-panel">
            {photoPreview ? (
              <>
                <img src={photoPreview} alt="Captured visit evidence" className="camera-photo-preview" />
                <div className="camera-capture-copy"><strong>Photo captured</strong><span>{Math.max(1, Math.round((photoFile?.size || 0) / 1024))} KB · Retake it if the agent or business location is not clearly visible.</span></div>
                <button type="button" onClick={retakePhoto} disabled={cameraLoading} className="btn btn-secondary camera-action-button">
                  <Camera size={17} />{cameraLoading ? 'Opening camera…' : 'Retake photo'}
                </button>
              </>
            ) : cameraActive ? (
              <>
                <div className="live-camera-frame"><video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" /></div>
                <div className="camera-capture-copy"><strong>Frame the agent or business location</strong><span>The photo is taken now with your device camera.</span></div>
                <div className="camera-button-row">
                  <button type="button" onClick={captureCameraPhoto} className="btn btn-primary camera-action-button"><Camera size={17} />Take photo</button>
                  <button type="button" onClick={stopCamera} className="btn btn-secondary camera-action-button">Close camera</button>
                </div>
              </>
            ) : (
              <>
                <div className="camera-instruction-icon"><Camera size={24} /></div>
                <div className="camera-capture-copy"><strong>Capture visit evidence</strong><span>Open your device camera and take a current photo. Photos from storage cannot be selected.</span></div>
                <button type="button" onClick={startCamera} disabled={cameraLoading} className="btn btn-primary camera-action-button">
                  <Camera size={17} />{cameraLoading ? 'Opening camera…' : 'Open camera'}
                </button>
                {cameraError && <p className="camera-error" role="alert">{cameraError}</p>}
              </>
            )}
            {cameraActive && cameraError && <p className="camera-error" role="alert">{cameraError}</p>}
          </div>

          <button
            onClick={handleSavePhoto}
            disabled={!photoFile || photoLoading}
            className="btn btn-primary camera-save-button"
            aria-live="polite"
          >
            {photoLoading
              ? photoUploadStage === 'uploading'
                ? photoUploadProgress >= 100 ? 'Upload sent; waiting for server…' : `Uploading photo${photoUploadProgress == null ? '…' : `… ${photoUploadProgress}%`}`
                : photoUploadStage === 'saving-local' ? 'Saving local backup…' : 'Saving photo…'
              : 'Save photo & continue'}
          </button>
        </div>
      )}

      {/* STEP 4: Visit Report */}
      {currentStep === 3 && (
        <div className="visit-workflow-step space-y-6">
          <h2 className="text-xl font-semibold text-[#202a4e] flex items-center"><FileText className="w-5 h-5 mr-2"/> Visit Report</h2>
          <p className="text-sm text-gray-600">Answer the visit questions configured by an administrator. Agent and visit locations are recorded separately from this report.</p>
          <div className="space-y-4">
            {(isMoolaPlus ? ['DDIN'] : ['IREMBO', 'DDIN']).map((section) => {
              const configured = checklist.filter((item) => (item.section || 'DDIN') === section);
              if (!configured.length && section === 'IREMBO') return null;
              return <section className="visit-report-section" key={section}>
                <div className="visit-report-section-heading"><span>{section === 'IREMBO' ? 'A' : isMoolaPlus ? 'M' : 'B'}</span><div><h3>{isMoolaPlus ? 'Moola Plus visit notes' : `Section ${section === 'IREMBO' ? 'A · IREMBO' : 'B · DDIN'}`}</h3><p>{section === 'IREMBO' ? 'Required · Complete every question before submitting.' : 'Optional · Answer these if relevant to the visit.'}</p></div></div>
                {configured.map((item) => (
                  <FormField key={item.id} label={item.text} required={!isMoolaPlus && section === 'IREMBO'}>
                    {item.type === 'NUMBER' ? (
                      <input className="input" type="number" step="any" value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))} required={!isMoolaPlus && section === 'IREMBO'} />
                    ) : item.type === 'YES_NO' ? (
                      <select className="input" value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))} required={!isMoolaPlus && section === 'IREMBO'}>
                        <option value="">Select an answer</option><option value="Yes">Yes</option><option value="No">No</option>
                      </select>
                    ) : item.type === 'MULTIPLE_CHOICE' ? (
                      <select className="input" value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))} required={!isMoolaPlus && section === 'IREMBO'}>
                        <option value="">Select an answer</option>{(item.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : (
                      <textarea className="input" rows={2} value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))} required={!isMoolaPlus && section === 'IREMBO'} />
                    )}
                  </FormField>
                ))}
                {section === 'DDIN' && !configured.length && <p className="text-sm text-gray-600">No optional DDIN questions have been configured.</p>}
              </section>;
            })}
          </div>

          <button
            onClick={handleSubmitReport}
            disabled={reportLoading || (!isMoolaPlus && checklist.some((item) => item.section === 'IREMBO' && !String(checklistData[item.id] ?? '').trim()))}
            className="w-full bg-[#202a4e] hover:bg-[#17213d] text-white py-3 rounded-md font-semibold flex items-center justify-center disabled:opacity-50"
          >
            {reportLoading ? 'Submitting...' : 'Submit Report'}
          </button>
        </div>
      )}

      {/* STEP 5: Review & Submit */}
      {currentStep === 4 && (
        <div className="visit-workflow-step space-y-6">
          <h2 className="text-xl font-semibold text-[#202a4e]">Review & Check Out</h2>
          
          <div className="space-y-4">
            <div className="flex justify-between border-b pb-2">
              <span className="text-gray-600">Agent</span>
              <span className="font-medium">{selectedAgent?.name}</span>
            </div>
            <div className="flex justify-between border-b pb-2">
              <span className="text-gray-600">GPS Status</span>
              <span className={`font-medium ${gpsData?.distance <= gpsData?.radius ? 'text-green-600' : 'text-amber-600'}`}>
                {gpsData?.distance <= gpsData?.radius ? 'Verified' : 'Flagged'} ({gpsData?.distance}m)
              </span>
            </div>
            <div className="space-y-2 border-b pb-3">
              <span className="text-gray-600 block">Visit report</span>
              {withoutDuplicateVisitQuestions(checklist).filter((item) => String(checklistData[item.id] ?? '').trim()).map((item) => <div className="flex justify-between gap-4" key={item.id}><span>{item.text}</span><span className="font-medium">{checklistData[item.id]}</span></div>)}
            </div>
            
            <div>
              <span className="text-gray-600 block mb-2">Photo Evidence</span>
              {photoPreview && <img src={photoPreview} alt="Evidence" className="h-32 object-cover rounded-md border border-gray-200" />}
            </div>
          </div>

          <button
            onClick={handleCompleteVisit}
            disabled={checkOutLoading}
            className="btn btn-primary w-full justify-center py-4 text-base disabled:opacity-50"
          >
            {checkOutLoading ? 'Completing...' : 'Complete Visit & Check Out'}
          </button>
        </div>
      )}
    </div>
  );
}
