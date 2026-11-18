// Sample Axonius assets in the real v2 shape (dotted field names, array values,
// always-present internal_axon_id + labels). Used by MockInventory so we can build
// and demo the whole feature before a live tenant is available. See the shape in
// docs/AXONIUS-API-REFERENCE.md. HR-DT-0031 lacks the remote-access-allowed tag on
// purpose, so tag-gating can be tested.
export const MOCK_ASSETS: Array<Record<string, unknown>> = [
  {
    internal_axon_id: 'axon-fin-lt-0142-0001',
    adapter_list_length: 3,
    labels: ['remote-access-allowed', 'finance'],
    'specific_data.data.hostname': ['FIN-LT-0142'],
    'specific_data.data.os.type': ['Windows'],
    'specific_data.data.os.distribution': ['11'],
    'specific_data.data.device_serial': ['PF2ABC01'],
    'specific_data.data.network_interfaces.mac_addresses': ['00:1A:2B:3C:4D:5E'],
    'specific_data.data.network_interfaces.ips': ['10.20.0.42'],
    'specific_data.data.last_seen': ['2026-11-18T18:29:00Z'],
  },
  {
    internal_axon_id: 'axon-eng-mbp-0077-0002',
    adapter_list_length: 2,
    labels: ['remote-access-allowed', 'engineering'],
    'specific_data.data.hostname': ['ENG-MBP-0077'],
    'specific_data.data.os.type': ['macOS'],
    'specific_data.data.os.distribution': ['15'],
    'specific_data.data.device_serial': ['C02XYZ123ABC'],
    'specific_data.data.network_interfaces.mac_addresses': ['AC:DE:48:00:11:22'],
    'specific_data.data.network_interfaces.ips': ['10.20.1.77'],
    'specific_data.data.last_seen': ['2026-11-18T17:33:00Z'],
  },
  {
    internal_axon_id: 'axon-hr-dt-0031-0003',
    adapter_list_length: 1,
    labels: ['hr'],
    'specific_data.data.hostname': ['HR-DT-0031'],
    'specific_data.data.os.type': ['Windows'],
    'specific_data.data.os.distribution': ['10'],
    'specific_data.data.device_serial': ['7CD2048X'],
    'specific_data.data.network_interfaces.mac_addresses': ['00:25:96:FF:AB:CD'],
    'specific_data.data.network_interfaces.ips': ['10.20.2.31'],
    'specific_data.data.last_seen': ['2026-11-16T09:10:00Z'],
  },
];
