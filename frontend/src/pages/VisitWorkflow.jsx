import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Phone
} from 'lucide-react';
import api from '../api';
import FormField from '../components/FormField';
import ListPagination from '../components/ListPagination';
import { useAuth } from '../AuthContext';
import { getAgentPack, getVisitDrafts, saveVisitDraft } from '../offline/store';

const makeClientVisitId = () => `CLT-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const distanceMeters = (a, b) => {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const STEPS = ['Select Agent', 'Check In', 'Photo', 'Report', 'Review'];
const sameTerritoryName = (left, right) => String(left || '').trim().toLocaleLowerCase() === String(right || '').trim().toLocaleLowerCase();

export default function VisitWorkflow() {
  const navigate = useNavigate();
  const { user } = useAuth();

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
  const [firstVisitFields, setFirstVisitFields] = useState({ territoryId: '', sectorId: '', cellId: '', cellName: '', villageId: '', villageName: '' });
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

  const [reportData, setReportData] = useState({
    operating_status: '',
    services_offered: '',
    products_offered: '',
    general_observations: '',
    liquidity_observations: '',
    customer_quality_observations: '',
    challenges_faced: '',
    support_needs: '',
    training_needs: '',
    follow_up_actions: '',
    additional_remarks: ''
  });
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
      setChecklist(items.map((item, index) => ({ ...item, id: item.id || `question-${index + 1}` })));
    };
    (async () => {
      if (user?.role?.toUpperCase() === 'TC') {
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
        if (!cancelled) setChecklist(items.map((item, index) => ({ ...item, id: item.id || `question-${index + 1}` })));
      } catch { if (!cancelled) setChecklist([]); }
    })();
    return () => { cancelled = true; };
  }, [user?.id, user?.role]);

  useEffect(() => {
    const territories = offlinePack?.territories || [];
    if (!territories.length || territories.some((territory) => territory.id === workTerritoryId)) return;
    setWorkTerritoryId(territories[0].id);
    setWorkSectorIds([]);
    setWorkCellIds([]);
    setWorkVillageIds([]);
  }, [offlinePack, workTerritoryId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAgentsLoading(true);
      setError(null);
      try {
        const { data } = await api.get('/api/v1/agents', {
          params: {
            page: agentPage, limit: agentPageSize, status: 'ACTIVE', search: searchQuery.trim() || undefined,
            territoryId: workTerritoryId || undefined,
            sectorIds: workSectorIds.length ? workSectorIds : undefined,
            cellIds: workCellIds.length ? workCellIds : undefined,
            villageIds: workVillageIds.length ? workVillageIds : undefined,
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
        try {
          const pack = offlinePack || await getAgentPack(user?.id);
          if (!pack?.agents) throw new Error('No saved field package. Connect once to download your assigned agents for offline visits.');
          const query = searchQuery.trim().toLocaleLowerCase();
          const areaIds = [...workSectorIds, ...workCellIds, ...workVillageIds];
          const filtered = pack.agents.filter((agent) => {
            const transferToSelected = agent.transfers?.some((transfer) => transfer.toTerritoryId === workTerritoryId);
            if (workTerritoryId && agent.territoryId !== workTerritoryId && !transferToSelected) return false;
            if (areaIds.length && !transferToSelected && !areaIds.some((id) => [agent.sectorId, agent.cellId, agent.villageId].includes(id))) return false;
            return !query || [agent.name, agent.phoneNumber, agent.agentId, agent.businessName, agent.address].some((value) => String(value || '').toLocaleLowerCase().includes(query));
          });
          const pages = Math.ceil(filtered.length / agentPageSize);
          const page = Math.min(agentPage, Math.max(pages, 1));
          const start = (page - 1) * agentPageSize;
          setAgents(filtered.slice(start, start + agentPageSize));
          setAgentTotal(filtered.length);
          setAgentPages(pages);
          setAgentPage(page);
          setRadiusMeters(Number(pack.radiusMeters) || 100);
          if (Array.isArray(pack.checklistSchema)) setChecklist(pack.checklistSchema.map((item, index) => ({ ...item, id: item.id || `question-${index + 1}` })));
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
  }, [agentPage, agentPageSize, searchQuery, offlinePack, user?.id, workTerritoryId, workSectorIds, workCellIds, workVillageIds]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) return undefined;
    (async () => {
      try {
        const drafts = await getVisitDrafts(user.id);
        const draft = [...drafts].reverse().find((item) => !item.completed && item.selectedAgent && item.checkInTime);
        if (!draft || cancelled) return;
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
        });
        setGpsData(draft.gpsData || null);
        setCheckInCoordinates(draft.checkInCoordinates || null);
        setGpsStatus('success');
        setCurrentStep(draft.currentStep || 1);
        setReportData((current) => ({ ...current, ...(draft.reportData || {}) }));
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
  }, [user?.id]);

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
    const incomingTransfer = agent.transfers?.find((transfer) => transfer.status === 'PENDING') || agent.transfers?.[0];
    const transferChangesDistrict = Boolean(incomingTransfer?.toTerritoryId && incomingTransfer.toTerritoryId !== agent.territoryId);
    setFirstVisitFields({
      territoryId: incomingTransfer?.toTerritoryId || agent.territoryId || workTerritoryId,
      sectorId: transferChangesDistrict ? '' : agent.sectorId || '',
      cellId: transferChangesDistrict ? '' : agent.cellId || '',
      cellName: transferChangesDistrict ? '' : agent.cell?.name || '',
      villageId: transferChangesDistrict ? '' : agent.villageId || '',
      villageName: transferChangesDistrict ? '' : agent.village?.name || '',
    });
    setTransferPanelOpen(false);
    setTransferTargets([]);
    setTransferTargetsLoaded(false);
    setTransferRequested(false);
    setCurrentStep(1);
    setError(null);
  };

  const persistDraft = async (overrides = {}) => {
    const id = overrides.clientVisitId || clientVisitId;
    if (!id || !user?.id) return;
    const captured = {
      clientVisitId: id,
      serverVisitId: overrides.serverVisitId !== undefined ? overrides.serverVisitId : (offlineVisit ? null : visitId),
      selectedAgent: overrides.selectedAgent || selectedAgent,
      checkInCoordinates: overrides.checkInCoordinates || checkInCoordinates,
      gpsData: overrides.gpsData || gpsData,
      currentStep: overrides.currentStep ?? currentStep,
      photoFile: overrides.photoFile !== undefined ? overrides.photoFile : photoFile,
      reportPayload: overrides.reportPayload !== undefined ? overrides.reportPayload : savedReportPayload,
      reportData: overrides.reportData || reportData,
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
      currentStep: captured.currentStep,
      photoBlob: captured.photoFile || undefined,
      photoName: captured.photoFile?.name,
      photoType: captured.photoFile?.type,
      reportPayload: captured.reportPayload,
      reportData: captured.reportData,
      checklistData: captured.checklistData,
      completed: captured.completed,
    });
  };

  const captureAgentLocation = () => {
    if (!selectedAgent) return;
    const locationAssignment = {
      territoryId: firstVisitFields.territoryId || selectedAgent.territoryId,
      sectorId: firstVisitFields.sectorId,
      cellId: firstVisitFields.cellId,
      cellName: firstVisitFields.cellName.trim(),
      villageId: firstVisitFields.villageId,
      villageName: firstVisitFields.villageName.trim(),
    };
    if (!locationAssignment.territoryId || !locationAssignment.sectorId || !locationAssignment.cellName || !locationAssignment.villageName) {
      setError('Choose or enter the district, sector, cell and village before capturing the first-visit location.');
      return;
    }
    if (!navigator.geolocation) { setError('This browser does not support GPS location.'); return; }
    setLocationCaptureLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      const capturedLocation = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, ...locationAssignment };
      try {
        if (!navigator.onLine) throw new Error('OFFLINE');
        const { data } = await api.post(`/api/v1/agents/${selectedAgent.id}/location/capture`, capturedLocation);
        setSelectedAgent({ ...data, pendingLocation: capturedLocation, locationSynced: true });
        setGpsStatus(null);
        setError(null);
      } catch (err) {
        if (!err.response && (err.message === 'OFFLINE' || !navigator.onLine)) {
          if (capturedLocation.accuracy > 20) setError('GPS accuracy must be 20 m or better. Move to an open area and capture again.');
          else {
            setSelectedAgent({
              ...selectedAgent, ...locationAssignment, registeredLatitude: capturedLocation.latitude, registeredLongitude: capturedLocation.longitude,
              gpsAccuracy: capturedLocation.accuracy, locationVerified: true, firstVisitLocationCapturedAt: new Date().toISOString(),
              pendingLocation: capturedLocation, locationSynced: false,
            });
            setGpsStatus(null);
            setError(null);
          }
        } else setError(err.response?.data?.error || 'Could not save the agent location. Try again in an open area.');
      } finally { setLocationCaptureLoading(false); }
    }, (err) => {
      setError(`Could not capture GPS: ${err.message}. Allow location access and try again.`);
      setLocationCaptureLoading(false);
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
  };

  const handleCheckIn = () => {
    setCheckInLoading(true);
    setGpsStatus('acquiring');
    setError(null);

    if (!navigator.geolocation) {
      setGpsStatus('error');
      setError('Geolocation is not supported by your browser.');
      setCheckInLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const stableId = clientVisitId || makeClientVisitId();
        const coordinates = { latitude, longitude, accuracy, timestamp: new Date(position.timestamp || Date.now()).toISOString() };
        const knownLocation = selectedAgent.pendingLocation || {
          latitude: selectedAgent.registeredLatitude,
          longitude: selectedAgent.registeredLongitude,
          accuracy: selectedAgent.gpsAccuracy,
        };
        const localDistance = knownLocation.latitude == null || knownLocation.longitude == null
          ? null : distanceMeters({ latitude, longitude }, { latitude: knownLocation.latitude, longitude: knownLocation.longitude });
        const localGpsData = { distance: localDistance == null ? 0 : Math.round(localDistance), radius: radiusMeters, accuracy: Math.round(accuracy), locationStatus: 'VERIFIED', publicId: stableId };
        const startLocally = async () => {
          if (!knownLocation || knownLocation.latitude == null || knownLocation.longitude == null) throw new Error('Capture the agent’s GPS location before starting this visit.');
          if (!selectedAgent.firstVisitCompletedAt && !selectedAgent.firstVisitLocationCapturedAt && !selectedAgent.pendingLocation) throw new Error('Complete the first-visit district, sector, cell, village and GPS capture before starting this visit.');
          if (!selectedAgent.locationVerified && !selectedAgent.pendingLocation) throw new Error('This agent’s GPS location is not verified yet. Connect to the network and refresh the agent package before starting an offline visit.');
          if (accuracy > 50) throw new Error(`GPS accuracy is ±${Math.round(accuracy)} m. Improve the signal before checking in (maximum ±50 m).`);
          if (localDistance > radiusMeters) throw new Error(`You are ${Math.round(localDistance)} m from the registered location. Check-in is allowed within ${radiusMeters} m.`);
          const id = stableId;
          setClientVisitId(id);
          setVisitId(id);
          setOfflineVisit(true);
          setCheckInCoordinates(coordinates);
          setGpsData(localGpsData);
          setGpsStatus('success');
          setCurrentStep(2);
          await persistDraft({ clientVisitId: id, serverVisitId: null, selectedAgent, checkInCoordinates: coordinates, gpsData: localGpsData, currentStep: 2 });
        };
        try {
          if (!navigator.onLine) {
            await startLocally();
            return;
          }
          let checkInAgent = selectedAgent;
          if (selectedAgent.pendingLocation && !selectedAgent.locationSynced) {
            const { data: updatedAgent } = await api.post(`/api/v1/agents/${selectedAgent.id}/location/capture`, selectedAgent.pendingLocation);
            checkInAgent = { ...updatedAgent, pendingLocation: selectedAgent.pendingLocation, locationSynced: true };
            setSelectedAgent(checkInAgent);
          }
          const res = await api.post('/api/v1/visits/check-in', {
            visitId: stableId,
            agentId: selectedAgent.id,
            tcLatitude: latitude,
            tcLongitude: longitude,
            gpsAccuracyMeters: accuracy
          });
          const nextGpsData = {
            distance: Math.round(res.data.distanceMeters),
            radius: res.data.radiusMeters,
            accuracy: Math.round(res.data.gpsAccuracyMeters),
            locationStatus: res.data.locationStatus,
            publicId: res.data.visitId,
          };
          setClientVisitId(stableId);
          setVisitId(res.data.id);
          setOfflineVisit(false);
          setCheckInCoordinates(coordinates);
          setGpsData(nextGpsData);
          setGpsStatus('success');
          setCurrentStep(2);
          await persistDraft({ clientVisitId: stableId, serverVisitId: res.data.id, selectedAgent: checkInAgent, checkInCoordinates: coordinates, gpsData: nextGpsData, currentStep: 2 });
        } catch (err) {
          if (!err.response && (!navigator.onLine || err.message === 'Network Error')) {
            try { await startLocally(); }
            catch (offlineError) { setGpsStatus('error'); setError(offlineError.message || 'Could not start this offline visit.'); }
          } else {
            setGpsStatus('error');
            setError(err.response?.data?.error || err.message || 'Failed to check in. Please try again.');
          }
        } finally {
          setCheckInLoading(false);
        }
      },
      (err) => {
        setGpsStatus('error');
        setError(`GPS Error: ${err.message}. Please ensure location services are enabled.`);
        setCheckInLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
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

  const handleReportChange = (field, value) => {
    setReportData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmitReport = async () => {
    setReportLoading(true);
    try {
      const reportPayload = {
        operatingStatus: reportData.operating_status,
        servicesOffered: reportData.services_offered,
        productsOffered: reportData.products_offered,
        generalObservations: reportData.general_observations,
        liquidityObservations: reportData.liquidity_observations,
        customerQualityObservations: reportData.customer_quality_observations,
        challengesFaced: reportData.challenges_faced,
        supportNeeds: reportData.support_needs,
        trainingNeeds: reportData.training_needs,
        followUpActions: reportData.follow_up_actions,
        additionalRemarks: reportData.additional_remarks,
        checklistData: Object.fromEntries(Object.entries(checklistData).map(([id, answer]) => [id, { question: checklist.find((item) => item.id === id)?.text || id, answer }])),
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
        const reportPayload = savedReportPayload || {
          operatingStatus: reportData.operating_status,
          servicesOffered: reportData.services_offered,
          productsOffered: reportData.products_offered,
          generalObservations: reportData.general_observations,
          liquidityObservations: reportData.liquidity_observations,
          customerQualityObservations: reportData.customer_quality_observations,
          challengesFaced: reportData.challenges_faced,
          supportNeeds: reportData.support_needs,
          trainingNeeds: reportData.training_needs,
          followUpActions: reportData.follow_up_actions,
          additionalRemarks: reportData.additional_remarks,
          checklistData,
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
  const updateLocationCell = (value) => {
    const match = locationCells.find((cell) => sameTerritoryName(cell.name, value));
    setFirstVisitFields((current) => ({
      ...current,
      cellId: match?.id || '',
      cellName: match?.name || value,
      villageId: '',
      villageName: '',
    }));
  };
  const updateLocationVillage = (value) => {
    const match = locationVillages.find((village) => sameTerritoryName(village.name, value));
    setFirstVisitFields((current) => ({
      ...current,
      villageId: match?.id || '',
      villageName: match?.name || value,
    }));
  };

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

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-md flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-700 font-bold">&times;</button>
        </div>
      )}

      {/* STEP 1: Select Agent */}
      {currentStep === 0 && (
        <div className="visit-agent-selection">
          <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900">Plan today’s territory</h2>
            <p className="mb-3 text-sm text-gray-600">Choose one of your assigned districts, then narrow the agent list to the sectors, cells or villages you plan to visit.</p>
            <label className="mb-3 block text-sm font-medium text-gray-700" htmlFor="visit-work-territory">District</label>
            <select id="visit-work-territory" className="form-select mb-3 w-full" value={workTerritoryId || workDistrict?.id || ''} onChange={(event) => {
              setWorkTerritoryId(event.target.value); setWorkSectorIds([]); setWorkCellIds([]); setWorkVillageIds([]); setAgentPage(1);
            }}>
              {workTerritories.map((territory) => <option value={territory.id} key={territory.id}>{territory.name}</option>)}
            </select>
            {!workTerritories.length && <p className="text-sm text-amber-800">Connect to refresh your assigned territories before planning the day.</p>}
            <div className="space-y-2">
              {renderAreaFilters('Sectors', workSectors, workSectorIds, setWorkSectorIds)}
              {renderAreaFilters('Cells', workCells, workCellIds, setWorkCellIds)}
              {renderAreaFilters('Villages', workVillages, workVillageIds, setWorkVillageIds)}
            </div>
          </section>
          <div className="visit-agent-list-heading">
            <div><h2>Choose the agent you are visiting</h2><p>Select an active agent to start the visit record.</p></div>
            <span>{agentsLoading ? 'Loading agents' : `${agentTotal} ${agentTotal === 1 ? 'agent' : 'agents'}`}</span>
          </div>
          <label className="visit-agent-search">
            <Search aria-hidden="true" />
            <input 
              type="text"
              placeholder="Search agent by name, phone, ID, or business..."
              aria-label="Search active agents"
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
                className="visit-agent-card"
              >
                <div className="visit-agent-card-main">
                  <div className="visit-agent-card-meta">
                    <span className="visit-agent-id">{agent.agentId}</span>
                    {agent.overdue && <span className="visit-agent-overdue">Visit overdue</span>}
                    {agent.transfers?.some((transfer) => transfer.status === 'PENDING') && <span className="visit-agent-overdue">Incoming transfer</span>}
                  </div>
                  <h3>{agent.name}</h3>
                  <p className="visit-agent-business">{agent.businessName || 'Independent agent'}</p>
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

          {transferRequested ? <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-green-900">
            <h3 className="font-semibold">Transfer request sent</h3>
            <p className="mt-1 text-sm">The coordinator in the destination district will assign the new village and record the agent’s location at the first visit.</p>
            <button type="button" className="btn btn-secondary mt-4" onClick={() => navigate('/visits')}>Return to visits</button>
          </div> : <div className="space-y-4">
            {!selectedAgent.firstVisitCompletedAt && <div className="first-visit-location-panel">
              <div className="first-visit-location-intro">
                <span className="first-visit-location-mark"><MapPin size={18} aria-hidden="true" /></span>
                <div>
                  <span className="first-visit-location-kicker">ONE-TIME FIELD RECORD</span>
                  <h3>Set the agent’s first-visit location</h3>
                  <p>Choose a saved cell or village, or enter its local name. New areas are saved under the selected parent when GPS is captured; the territory and GPS are then locked.</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm font-medium text-gray-700">District
                  <select className="form-select mt-1 w-full" value={firstVisitFields.territoryId} disabled={Boolean(selectedAgent.firstVisitLocationCapturedAt)} onChange={(event) => setFirstVisitFields({ territoryId: event.target.value, sectorId: '', cellId: '', cellName: '', villageId: '', villageName: '' })}>
                    <option value="">Choose district</option>{workTerritories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="text-sm font-medium text-gray-700">Sector
                  <select className="form-select mt-1 w-full" value={firstVisitFields.sectorId} disabled={Boolean(selectedAgent.firstVisitLocationCapturedAt)} onChange={(event) => setFirstVisitFields((current) => ({ ...current, sectorId: event.target.value, cellId: '', cellName: '', villageId: '', villageName: '' }))}>
                    <option value="">Choose sector</option>{locationSectors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <div className="first-visit-area-field">
                  <div className="first-visit-area-heading"><label htmlFor="first-visit-cell">Cell</label><span>{locationCells.length ? `${locationCells.length} saved` : 'New entry'}</span></div>
                  <div className="first-visit-area-control"><Search size={16} aria-hidden="true" /><input id="first-visit-cell" aria-describedby="first-visit-cell-hint" className="first-visit-area-input" type="text" list="first-visit-cell-options" value={firstVisitFields.cellName} disabled={Boolean(selectedAgent.firstVisitLocationCapturedAt) || !locationSector} onChange={(event) => updateLocationCell(event.target.value)} placeholder={locationSector ? 'Choose or enter a cell' : 'Choose a sector first'} maxLength={100} autoComplete="off" /></div>
                  <datalist id="first-visit-cell-options">{locationCells.map((item) => <option key={item.id} value={item.name} />)}</datalist>
                  <p id="first-visit-cell-hint" className={`first-visit-area-hint${firstVisitFields.cellName && !firstVisitFields.cellId ? ' is-custom' : ''}`}>{firstVisitFields.cellName && !firstVisitFields.cellId ? `“${firstVisitFields.cellName}” will be saved under this sector.` : locationCells.length ? 'Type to find a saved cell or enter a new name.' : 'No saved cells in this sector yet. Enter the local cell name.'}</p>
                </div>
                <div className="first-visit-area-field">
                  <div className="first-visit-area-heading"><label htmlFor="first-visit-village">Village</label><span>{locationVillages.length ? `${locationVillages.length} saved` : 'New entry'}</span></div>
                  <div className="first-visit-area-control"><Search size={16} aria-hidden="true" /><input id="first-visit-village" aria-describedby="first-visit-village-hint" className="first-visit-area-input" type="text" list="first-visit-village-options" value={firstVisitFields.villageName} disabled={Boolean(selectedAgent.firstVisitLocationCapturedAt) || !firstVisitFields.cellName.trim()} onChange={(event) => updateLocationVillage(event.target.value)} placeholder={firstVisitFields.cellName ? 'Choose or enter a village' : 'Choose or enter a cell first'} maxLength={100} autoComplete="off" /></div>
                  <datalist id="first-visit-village-options">{locationVillages.map((item) => <option key={item.id} value={item.name} />)}</datalist>
                  <p id="first-visit-village-hint" className={`first-visit-area-hint${firstVisitFields.villageName && !firstVisitFields.villageId ? ' is-custom' : ''}`}>{firstVisitFields.villageName && !firstVisitFields.villageId ? `“${firstVisitFields.villageName}” will be saved under this cell.` : locationVillages.length ? 'Type to find a saved village or enter a new name.' : 'No saved villages in this cell yet. Enter the local village name.'}</p>
                </div>
              </div>
              {selectedAgent.firstVisitLocationCapturedAt ? <p className="mt-3 text-sm font-medium text-green-800">The first-visit location has been captured and locked.</p> : <button onClick={captureAgentLocation} disabled={locationCaptureLoading || !locationSector || !firstVisitFields.cellName.trim() || !firstVisitFields.villageName.trim()} className="btn btn-primary mt-4 w-full justify-center disabled:opacity-50" type="button">
                <MapPin size={17} />{locationCaptureLoading ? 'Capturing precise location…' : 'Capture first-visit location'}
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
            {gpsStatus === 'success' && gpsData && (
              <div className="bg-green-50 text-green-700 p-4 rounded-md flex items-start border border-green-200">
                <CheckCircle className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0" /> 
                <div>Location verified — {gpsData.distance}m from agent (within {gpsData.radius}m radius)</div>
              </div>
            )}
            {gpsStatus === 'outside_radius' && gpsData && (
              <div className="bg-red-50 text-red-700 p-4 rounded-md flex items-start border border-red-200">
                <AlertTriangle className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0" />
                <div>You are {gpsData.distance}m from the registered location. This visit will be flagged for human review. Allowed radius: {gpsData.radius}m.</div>
              </div>
            )}
            {gpsStatus === 'low_accuracy' && gpsData && (
              <div className="bg-amber-50 text-amber-700 p-4 rounded-md flex items-start border border-amber-200">
                <AlertTriangle className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0" />
                <div>GPS accuracy is low (±{gpsData.accuracy}m). Improve the signal for a verified visit, or continue with this visit marked for review.</div>
              </div>
            )}

            <button
              onClick={handleCheckIn}
              disabled={checkInLoading || gpsStatus === 'success' || selectedAgent.registeredLatitude == null || selectedAgent.registeredLongitude == null || (!selectedAgent.locationVerified && !selectedAgent.pendingLocation) || (!selectedAgent.firstVisitCompletedAt && !selectedAgent.firstVisitLocationCapturedAt && !selectedAgent.pendingLocation)}
              className="btn btn-primary w-full justify-center py-4 text-base disabled:opacity-50"
            >
              <MapPin className="w-6 h-6 mr-2" />
              {checkInLoading ? 'Checking in...' : (gpsStatus === 'success' ? 'Checked In' : 'Check In')}
            </button>
          </div>}
        </div>
      )}

      {/* STEP 3: Camera Capture */}
      {currentStep === 2 && (
        <div className="visit-workflow-step camera-capture-step">
          {gpsData && (
            <div className={`camera-location-status ${gpsData.distance <= gpsData.radius ? 'is-verified' : 'is-review'}`}>
              <span>Location status</span><strong>{gpsData.distance <= gpsData.radius ? 'Verified' : 'Unverified'}</strong><small>{gpsData.distance} m from registered location</small>
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
          
          <div className="space-y-4">
            <FormField.Select
              label="Operating Status"
              options={[
                { value: 'Operational', label: 'Operational' },
                { value: 'Temporarily Closed', label: 'Temporarily Closed' },
                { value: 'Permanently Closed', label: 'Permanently Closed' }
              ]}
              value={reportData.operating_status}
              onChange={(e) => handleReportChange('operating_status', e.target.value)}
              required
            />
            <FormField.Textarea
              label="Services Offered"
              value={reportData.services_offered}
              onChange={(e) => handleReportChange('services_offered', e.target.value)}
              rows={2}
            />
            <FormField.Textarea
              label="Products Offered"
              value={reportData.products_offered}
              onChange={(e) => handleReportChange('products_offered', e.target.value)}
              rows={2}
            />
            <FormField.Textarea
              label="General Observations"
              value={reportData.general_observations}
              onChange={(e) => handleReportChange('general_observations', e.target.value)}
              rows={3}
            />
            <FormField.Textarea
              label="Liquidity Observations"
              value={reportData.liquidity_observations}
              onChange={(e) => handleReportChange('liquidity_observations', e.target.value)}
              rows={2}
            />
            <FormField.Textarea
              label="Customer Quality Observations"
              value={reportData.customer_quality_observations}
              onChange={(e) => handleReportChange('customer_quality_observations', e.target.value)}
              rows={2}
            />
            <FormField.Textarea
              label="Challenges Faced"
              value={reportData.challenges_faced}
              onChange={(e) => handleReportChange('challenges_faced', e.target.value)}
              rows={3}
            />
            <FormField.Textarea
              label="Support Needs"
              value={reportData.support_needs}
              onChange={(e) => handleReportChange('support_needs', e.target.value)}
              rows={2}
            />
            <FormField.Textarea
              label="Training Needs"
              value={reportData.training_needs}
              onChange={(e) => handleReportChange('training_needs', e.target.value)}
              rows={2}
            />
            <FormField.Textarea
              label="Follow-up Actions"
              value={reportData.follow_up_actions}
              onChange={(e) => handleReportChange('follow_up_actions', e.target.value)}
              rows={3}
            />
            {checklist.map((item) => (
              <FormField key={item.id} label={item.text} required={Boolean(item.required)}>
                {item.type === 'YES_NO' ? (
                  <select className="input" value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))}>
                    <option value="">Select an answer</option><option value="Yes">Yes</option><option value="No">No</option>
                  </select>
                ) : item.type === 'MULTIPLE_CHOICE' ? (
                  <select className="input" value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))}>
                    <option value="">Select an answer</option>{(item.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <textarea className="input" rows={2} value={checklistData[item.id] || ''} onChange={(event) => setChecklistData((current) => ({ ...current, [item.id]: event.target.value }))} />
                )}
              </FormField>
            ))}
            <FormField.Textarea
              label="Additional Remarks"
              value={reportData.additional_remarks}
              onChange={(e) => handleReportChange('additional_remarks', e.target.value)}
              rows={2}
            />
          </div>

          <button
            onClick={handleSubmitReport}
            disabled={reportLoading || !reportData.operating_status}
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
            <div className="flex justify-between border-b pb-2">
              <span className="text-gray-600">Operating Status</span>
              <span className="font-medium">{reportData.operating_status}</span>
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
