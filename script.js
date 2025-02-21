"use strict";

/****************************************************
 * =========== เชื่อมต่อกับ Supabase ================
 ****************************************************/
document.addEventListener('DOMContentLoaded', async () => {
  // ตรวจสอบว่า Supabase client โหลดสำเร็จจาก index.html หรือไม่
  if (!window.supabase) {
    console.error('Supabase client not initialized');
    alert('ไม่สามารถเชื่อมต่อระบบได้ กรุณารีเฟรชหน้า');
    return;
  }

  // ดำเนินการโหลดหน้าเมื่อ DOM และ Supabase พร้อม
  try {
    const user = await getCurrentUser();
    if (user) updateUIAfterLogin(user);
    await renderProducts();
    await renderAIRecommendations();
    await updateCartCount();
  } catch (err) {
    console.error('Error during page load:', err);
  }
});

// ฟังก์ชันรอ Supabase หากจำเป็น (ใช้ในกรณีที่อาจมีการหน่วงเวลา)
function ensureSupabase() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Supabase initialization timed out'));
    }, 10000); // รอสูงสุด 10 วินาที
    const interval = setInterval(() => {
      if (window.supabase) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);
  });
}

// ฟังก์ชันดึงข้อมูลผู้ใช้ปัจจุบัน
async function getCurrentUser() {
  if (!window.supabase) {
    console.error('Supabase not initialized');
    return null;
  }
  try {
    await ensureSupabase(); // รอให้แน่ใจว่า Supabase พร้อมจริงๆ
    const { data: { user } } = await window.supabase.auth.getUser();
    return user || null;
  } catch (err) {
    console.error('Error getting current user:', err);
    return null;
  }
}

// ฟังก์ชันอื่นๆ ใน script.js สามารถเรียกใช้ getCurrentUser ได้ตามปกติ
async function syncUserBehavior(behaviorData) {
  try {
    const formattedData = [];
    const user = await getCurrentUser();
    const userId = user?.id;

    if (!userId) {
      console.warn("No user authenticated for syncUserBehavior");
      return null;
    }

    if (behaviorData.productViews) {
      Object.entries(behaviorData.productViews).forEach(([productId, views]) => {
        formattedData.push({
          user_id: userId,
          product_id: productId,
          action_type: "view",
          created_at: new Date().toISOString(),
        });
      });
    }

    if (behaviorData.searches) {
      behaviorData.searches.forEach(search => {
        formattedData.push({
          user_id: userId,
          action_type: "search",
          search_term: search.term,
          created_at: new Date(search.timestamp).toISOString(),
        });
      });
    }

    if (behaviorData.purchases) {
      behaviorData.purchases.forEach(purchase => {
        const cartItems = purchase.items || [];
        formattedData.push({
          user_id: userId,
          action_type: "purchase",
          purchases: JSON.stringify(cartItems),
          created_at: new Date(purchase.timestamp).toISOString(),
        });
      });
    }

    if (formattedData.length === 0) {
      console.log("No behavior data to sync");
      return null;
    }

    const { data, error } = await window.supabase
      .from('user_behavior')
      .insert(formattedData);

    if (error) {
      console.error('Error inserting user_behavior data:', error);
      return null;
    }
    console.log('User behavior data inserted successfully:', data);
    return data;
  } catch (err) {
    console.error('syncUserBehavior exception:', err);
    return null;
  }
}

async function updateUserBehavior(updateData, condition) {
  try {
    const { data, error } = await window.supabase
      .from('user_behavior')
      .update(updateData)
      .match(condition);

    if (error) {
      console.error('Error updating user_behavior data:', error);
      return null;
    }
    console.log('User behavior data updated successfully:', data);
    return data;
  } catch (err) {
    console.error('updateUserBehavior exception:', err);
    return null;
  }
}

async function uploadModelFile(folder, fileName, fileData) {
  try {
    const filePath = `${folder}/${fileName}`;
    const { data, error } = await window.supabase.storage
      .from('Model')
      .upload(filePath, fileData, {
        cacheControl: '3600',
        upsert: true,
      });

    if (error) {
      console.error('Error uploading model file:', error);
      return null;
    }
    console.log('Model file uploaded successfully:', data);
    return data;
  } catch (err) {
    console.error('uploadModelFile exception:', err);
    return null;
  }
}

async function syncDataAfterTraining() {
  try {
    const behaviorRaw = localStorage.getItem('ai_user_behavior');
    if (!behaviorRaw) {
      console.warn('No user behavior data found in localStorage');
      return;
    }
    const behaviorData = JSON.parse(behaviorRaw);
    await syncUserBehavior(behaviorData);

    const modelJSON = localStorage.getItem('locnet-ml-model');
    if (!modelJSON) {
      console.warn('No model data found in localStorage with key "locnet-ml-model"');
      return;
    }
    const modelBlob = new Blob([modelJSON], { type: 'application/json' });
    await uploadModelFile('my-models', 'model.json', modelBlob);
  } catch (err) {
    console.error('syncDataAfterTraining error:', err);
  }
}

/****************************************************
 * LocNetAI Class
 ****************************************************/

class LocNetAI {
  constructor() {
    this.storageKeys = {
      userBehavior: 'ai_user_behavior',
      recommendations: 'ai_recommendations',
      systemState: 'ai_system_state',
      performance: 'ai_performance'
    };
    this.loadSystemState();
    this.initializeTracking();
  }

  loadSystemState() {
    try {
      const savedState = localStorage.getItem(this.storageKeys.systemState);
      this.state = savedState
        ? JSON.parse(savedState)
        : { mode: 'minimal', lastUpdate: Date.now(), performanceScore: 0 };
    } catch (error) {
      console.error('Error loading state:', error);
      this.state = { mode: 'minimal', lastUpdate: Date.now(), performanceScore: 0 };
    }
  }

  initializeTracking() {
    document.querySelectorAll('.product-card').forEach((card) => {
      card.addEventListener('click', async (e) => {
        await this.trackProductView(e);
      });
    });

    const searchInput = document.querySelector('.filter-group input[type="text"]');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => this.trackSearch(e));
    }

    const cartSidebar = document.getElementById('cartSidebar');
    if (cartSidebar) {
      cartSidebar.addEventListener('click', async (e) => {
        if (e.target.matches('.btn-primary')) {
          await this.trackPurchase(e);
        }
      });
    }
  }

  async trackProductView(event) {
    const productId = event.currentTarget.dataset.productId;
    if (!productId) return;

    try {
      let behavior = JSON.parse(localStorage.getItem(this.storageKeys.userBehavior) || '{}');
      if (!behavior.productViews) behavior.productViews = {};
      if (!behavior.productViews[productId]) behavior.productViews[productId] = 0;
      behavior.productViews[productId]++;
      localStorage.setItem(this.storageKeys.userBehavior, JSON.stringify(behavior));
      await this.updateRecommendations();
      await syncDataAfterTraining();
    } catch (error) {
      console.error('Error tracking product view:', error);
    }
  }

  trackSearch(event) {
    const searchTerm = event.target.value.trim().toLowerCase();
    if (!searchTerm) return;

    try {
      let behavior = JSON.parse(localStorage.getItem(this.storageKeys.userBehavior) || '{}');
      if (!behavior.searches) behavior.searches = [];
      behavior.searches.push({ term: searchTerm, timestamp: Date.now() });
      if (behavior.searches.length > 100) behavior.searches = behavior.searches.slice(-100);
      localStorage.setItem(this.storageKeys.userBehavior, JSON.stringify(behavior));
      syncDataAfterTraining();
    } catch (error) {
      console.error('Error tracking search:', error);
    }
  }

  async trackPurchase(event) {
    try {
      const cart = JSON.parse(localStorage.getItem('cart') || '[]');
      let behavior = JSON.parse(localStorage.getItem(this.storageKeys.userBehavior) || '{}');
      if (!behavior.purchases) behavior.purchases = [];
      behavior.purchases.push({ items: cart, timestamp: Date.now() });
      localStorage.setItem(this.storageKeys.userBehavior, JSON.stringify(behavior));
      await this.updateRecommendations();
      await syncDataAfterTraining();
    } catch (error) {
      console.error('Error tracking purchase:', error);
    }
  }

  async updateRecommendations() {
    try {
      const behavior = JSON.parse(localStorage.getItem(this.storageKeys.userBehavior) || '{}');
      const products = JSON.parse(localStorage.getItem('products') || '[]');
      const scores = {};
      for (const product of products) {
        scores[product.id] = await this.calculateProductScore(product, behavior);
      }
      const recommendations = products
        .sort((a, b) => scores[b.id] - scores[a.id])
        .slice(0, 5);
      localStorage.setItem(this.storageKeys.recommendations, JSON.stringify(recommendations));
      this.updateRecommendationDisplay(recommendations);
    } catch (error) {
      console.error('Error updating recommendations:', error);
    }
  }

  async calculateProductScore(product, behavior) {
    let score = 0;
    if (behavior.productViews && behavior.productViews[product.id]) {
      score += behavior.productViews[product.id] * 0.3;
    }
    if (behavior.searches) {
      const relevantSearches = behavior.searches.filter((search) =>
        product.name.toLowerCase().includes(search.term) ||
        (product.description && product.description.toLowerCase().includes(search.term))
      );
      score += relevantSearches.length * 0.2;
    }
    if (behavior.purchases) {
      const relatedPurchases = behavior.purchases.filter((purchase) =>
        purchase.items.some((item) =>
          item.name && product.name &&
          (item.name.toLowerCase().includes(product.name.toLowerCase()) ||
           product.name.toLowerCase().includes(item.name.toLowerCase()))
        )
      );
      score += relatedPurchases.length * 0.5;
    }
    return score;
  }

  updateRecommendationDisplay(recommendations) {
    const aiRecommendGrid = document.getElementById('aiRecommendGrid');
    if (!aiRecommendGrid) return;
    aiRecommendGrid.innerHTML = '';
    const fragment = document.createDocumentFragment();
    recommendations.forEach((product) => {
      const card = document.createElement('div');
      card.className = 'product-card';
      card.innerHTML = `
        <img src="${product.image_url}" alt="${product.name}" class="product-image">
        <div class="product-info">
          <h3>${product.name}</h3>
          <p>${product.description || ''}</p>
          <div class="product-price">฿${product.price}</div>
        </div>
        <div class="product-actions">
          <a href="#" class="action-button action-add-to-cart" data-product-id="${product.id}">
            <i class="fas fa-shopping-cart"></i> เพิ่มลงตะกร้า
          </a>
        </div>
      `;
      fragment.appendChild(card);
    });
    aiRecommendGrid.appendChild(fragment);
  }

  cleanup() {
    try {
      let behavior = JSON.parse(localStorage.getItem(this.storageKeys.userBehavior) || '{}');
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (behavior.searches) {
        behavior.searches = behavior.searches.filter((search) => search.timestamp > thirtyDaysAgo);
      }
      if (behavior.purchases) {
        behavior.purchases = behavior.purchases.filter((purchase) => purchase.timestamp > thirtyDaysAgo);
      }
      localStorage.setItem(this.storageKeys.userBehavior, JSON.stringify(behavior));
    } catch (error) {
      console.error('Error cleaning up:', error);
    }
  }
}

/****************************************************
 * ML-AI Functions
 ****************************************************/

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, function(match) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match];
  });
}

function validateImageURL(url) {
  const allowedPrefixes = ['http://', 'https://', 'data:'];
  for (let prefix of allowedPrefixes) {
    if (url.startsWith(prefix)) return url;
  }
  return 'https://via.placeholder.com/300x200';
}

class MLSystem {
  constructor() {
    this.model = null;
    this.initialized = false;
  }

  async initializeModel() {
    try {
      this.model = tf.sequential({
        layers: [
          tf.layers.dense({ inputShape: [5], units: 8, activation: 'relu' }),
          tf.layers.dense({ units: 1, activation: 'sigmoid' })
        ]
      });
      this.model.compile({
        optimizer: tf.train.adam(0.01),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
      });
      this.initialized = true;
      console.log('Base ML Model initialized');
    } catch (error) {
      console.error('Error initializing base ML model:', error);
    }
  }

  async train(data, labels) {
    if (!this.initialized) await this.initializeModel();
    try {
      console.log('Starting training...', 'Data size:', data.length, 'Labels size:', labels.length);
      const xs = tf.tensor2d(data);
      const ys = tf.tensor2d(labels, [labels.length, 1]);
      console.log('Train data shape:', xs.shape, 'Label shape:', ys.shape);
      await this.model.fit(xs, ys, {
        epochs: 10,
        batchSize: 32,
        verbose: 1,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            const acc = (logs.acc * 100).toFixed(2);
            console.log(`Epoch ${epoch + 1} => loss: ${logs.loss.toFixed(4)}, accuracy: ${acc}%`);
          }
        }
      });
      xs.dispose();
      ys.dispose();
      console.log('Training completed.');
    } catch (error) {
      console.error('Error training base model:', error);
    }
  }

  async predict(input) {
    if (!this.initialized) {
      await this.initializeModel();
      return null;
    }
    try {
      let inputArr = Array.isArray(input) ? input : [
        input.views || 0,
        input.searches || 0,
        input.purchases || 0,
        input.price || 0,
        input.category || 0
      ];
      console.log('Predicting with input array:', inputArr);
      const inputTensor = tf.tensor2d([inputArr], [1, 5]);
      const prediction = this.model.predict(inputTensor);
      const result = await prediction.data();
      inputTensor.dispose();
      prediction.dispose();
      console.log('Prediction result:', result[0]);
      return result[0];
    } catch (error) {
      console.error('Error making prediction:', error);
      return null;
    }
  }

  async getTestData() {
    try {
      const behavior = JSON.parse(localStorage.getItem('ai_user_behavior') || '{}');
      const products = JSON.parse(localStorage.getItem('products') || '[]');
      if (!behavior.purchases || !products.length) return { data: [], labels: [] };
      const data = [];
      const labels = [];
      products.forEach(product => {
        data.push({
          views: behavior.productViews?.[product.id] || 0,
          searches: 0,
          purchases: behavior.purchases?.filter(p => p.items.some(i => i.id === product.id)).length || 0,
          price: product.price,
          category: 0
        });
        labels.push(behavior.purchases?.some(p => p.items.some(i => i.id === product.id)) ? 1 : 0);
      });
      return { data, labels };
    } catch (error) {
      console.error('Error getting test data:', error);
      return { data: [], labels: [] };
    }
  }

  async saveModel() {
    if (!this.initialized) return;
    try {
      await this.model.save('localstorage://locnet-ml-model');
      console.log('Model saved to localstorage://locnet-ml-model');
    } catch (error) {
      console.error('Error saving base model:', error);
    }
  }

  async loadModel() {
    try {
      this.model = await tf.loadLayersModel('localstorage://locnet-ml-model');
      this.initialized = true;
      console.log('Loaded model from localstorage://locnet-ml-model');
    } catch (error) {
      console.log('No saved model found, initializing new model');
      await this.initializeModel();
    }
  }
}

class AIStatusUpdater {
  static updateStatus(mode, resources) {
    const modeElement = document.getElementById('ai-mode');
    const resourcesElement = document.getElementById('ai-resources');
    if (modeElement) {
      modeElement.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      modeElement.style.color = this.getModeColor(mode);
    }
    if (resourcesElement && resources) {
      resourcesElement.textContent = `CPU: ${Math.round(resources.cpu)}% | RAM: ${Math.round(resources.memory)}% | Storage: ${Math.round(resources.storage)}%`;
    }
  }

  static getModeColor(mode) {
    const colors = { minimal: '#ff9800', light: '#4caf50', normal: '#2196f3', advanced: '#9c27b0' };
    return colors[mode] || '#ffffff';
  }
}

class AdaptiveMLSystem extends MLSystem {
  constructor() {
    super();
    this.modelStructures = {
      minimal: {
        layers: [
          { inputShape: [5], units: 4, activation: 'relu' },
          { units: 1, activation: 'sigmoid' }
        ],
        batchSize: 16,
        trainingInterval: 24 * 60 * 60 * 1000
      },
      light: {
        layers: [
          { inputShape: [5], units: 8, activation: 'relu' },
          { units: 4, activation: 'relu' },
          { units: 1, activation: 'sigmoid' }
        ],
        batchSize: 32,
        trainingInterval: 12 * 60 * 60 * 1000
      },
      normal: {
        layers: [
          { inputShape: [5], units: 16, activation: 'relu' },
          { units: 8, activation: 'relu' },
          { units: 4, activation: 'relu' },
          { units: 1, activation: 'sigmoid' }
        ],
        batchSize: 64,
        trainingInterval: 6 * 60 * 60 * 1000
      },
      advanced: {
        layers: [
          { inputShape: [5], units: 32, activation: 'relu' },
          { units: 16, activation: 'relu' },
          { units: 8, activation: 'relu' },
          { units: 4, activation: 'relu' },
          { units: 1, activation: 'sigmoid' }
        ],
        batchSize: 128,
        trainingInterval: 3 * 60 * 60 * 1000
      }
    };
    this.currentMode = 'minimal';
    this.resourceMonitor = new ResourceMonitor();
    this.evolutionHistory = [];
    this.startResourceMonitoring();
  }

  async startResourceMonitoring() {
    setInterval(async () => {
      const resources = await this.resourceMonitor.checkResources();
      await this.evolveBasedOnResources(resources);
    }, 5 * 60 * 1000);
  }

  async evolveBasedOnResources(resources) {
    const newMode = this.determineOptimalMode(resources);
    AIStatusUpdater.updateStatus(newMode, resources);
    if (newMode !== this.currentMode) {
      console.log(`Evolving from ${this.currentMode} to ${newMode} mode`);
      const previousMode = this.currentMode;
      const currentPerformance = await this.evaluatePerformance();
      await this.evolveModel(newMode);
      const newPerformance = await this.evaluatePerformance();
      if (newPerformance < currentPerformance * 0.9) {
        console.log('Performance degraded, rolling back evolution');
        await this.evolveModel(previousMode);
      } else {
        this.currentMode = newMode;
        this.evolutionHistory.push({
          timestamp: Date.now(),
          fromMode: previousMode,
          toMode: newMode,
          resources: resources,
          performance: newPerformance
        });
      }
    }
  }

  async evolveModel(mode) {
    const structure = this.modelStructures[mode];
    const newModel = tf.sequential();
    structure.layers.forEach((layer, index) => {
      if (index === 0) {
        newModel.add(tf.layers.dense({
          inputShape: layer.inputShape,
          units: layer.units,
          activation: layer.activation
        }));
      } else {
        newModel.add(tf.layers.dense({
          units: layer.units,
          activation: layer.activation
        }));
      }
    });
    newModel.compile({
      optimizer: tf.train.adam(0.01),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });
    if (this.model) {
      const oldWeights = this.model.getWeights();
      const compatibleWeights = this.adjustWeights(oldWeights, newModel);
      if (compatibleWeights) newModel.setWeights(compatibleWeights);
    }
    this.model = newModel;
    this.batchSize = structure.batchSize;
    this.trainingInterval = structure.trainingInterval;
  }

  adjustWeights(oldWeights, newModel) {
    try {
      const newWeights = newModel.getWeights();
      const adjustedWeights = [];
      const n = Math.min(oldWeights.length, newWeights.length);
      for (let i = 0; i < n; i++) {
        const targetWeight = newWeights[i];
        const targetShape = targetWeight.shape;
        const oldWeight = oldWeights[i];
        if (oldWeight.shape.length === targetShape.length) {
          let canSlice = true;
          for (let d = 0; d < targetShape.length; d++) {
            if (oldWeight.shape[d] < targetShape[d]) {
              canSlice = false;
              break;
            }
          }
          let adjusted = canSlice ? tf.tidy(() => oldWeight.slice(new Array(targetShape.length).fill(0), targetShape)) : targetWeight;
          adjustedWeights.push(adjusted);
        } else {
          adjustedWeights.push(targetWeight);
        }
      }
      for (let i = n; i < newWeights.length; i++) {
        adjustedWeights.push(newWeights[i]);
      }
      return adjustedWeights;
    } catch (error) {
      console.log('Cannot adjust weights, using new random weights');
      return null;
    }
  }

  async evaluatePerformance() {
    try {
      const testData = await this.getTestData();
      if (!testData || testData.data.length === 0) return 1;
      const predictions = await Promise.all(testData.data.map(input => this.predict(input)));
      const accuracy = predictions.reduce((acc, pred, idx) => {
        const actual = testData.labels[idx];
        return acc + (Math.abs(pred - actual) < 0.5 ? 1 : 0);
      }, 0) / predictions.length;
      return accuracy;
    } catch (error) {
      console.error('Error evaluating performance:', error);
      return 0;
    }
  }

  determineOptimalMode(resources) {
    const score = resources.memory * 0.4 + resources.cpu * 0.4 + resources.storage * 0.2;
    if (score < 30) return 'minimal';
    if (score < 50) return 'light';
    if (score < 80) return 'normal';
    return 'advanced';
  }
}

class ResourceMonitor {
  async checkResources() {
    const memory = await this.checkMemory();
    const cpu = await this.checkCPU();
    const storage = await this.checkStorage();
    return { memory, cpu, storage };
  }

  async checkMemory() {
    try {
      if (performance.memory) {
        return (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100;
      }
      return this.estimateMemoryUsage();
    } catch (error) {
      return 50;
    }
  }

  async checkCPU() {
    const startTime = performance.now();
    let total = 0;
    for (let i = 0; i < 1000000; i++) total += Math.random();
    const duration = performance.now() - startTime;
    return Math.min((duration / 100) * 100, 100);
  }

  async checkStorage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const quota = await navigator.storage.estimate();
        return (quota.usage / quota.quota) * 100;
      }
      return this.estimateStorageUsage();
    } catch (error) {
      return 50;
    }
  }

  estimateMemoryUsage() {
    let usage = 0;
    try {
      const arr = new Array(1000000).fill('x');
      usage = 50 * (1 - (arr.length / 1000000));
      return usage;
    } catch (error) {
      return 75;
    }
  }

  estimateStorageUsage() {
    try {
      let total = 0;
      for (const key in localStorage) {
        if (localStorage.hasOwnProperty(key)) total += localStorage[key].length;
      }
      return Math.min((total / (5 * 1024 * 1024)) * 100, 100);
    } catch (error) {
      return 50;
    }
  }
}

class MLEnhancedAI extends LocNetAI {
  constructor() {
    super();
    this.mlSystem = new AdaptiveMLSystem();
    this.storageKeys = { userBehavior: 'ai_user_behavior' };
    this.initializeML();
  }

  async initializeML() {
    try {
      await this.mlSystem.loadModel();
      console.log('ML Model loaded');
    } catch (error) {
      console.log('No saved model found, initializing new model');
      await this.mlSystem.initializeModel();
    }
    this.startMLTraining();
  }

  startMLTraining() {
    setInterval(async () => {
      const trainingData = this.prepareTrainingData();
      if (trainingData.data.length > 0) await this.mlSystem.train(trainingData.data, trainingData.labels);
    }, 24 * 60 * 60 * 1000);
  }

  prepareTrainingData() {
    const behavior = JSON.parse(localStorage.getItem(this.storageKeys.userBehavior) || '{}');
    const data = [];
    const labels = [];
    if (behavior.purchases) {
      behavior.purchases.forEach(purchase => {
        purchase.items.forEach(item => {
          data.push({
            views: behavior.productViews?.[item.id] || 0,
            searches: this.countRelatedSearches(item, behavior.searches || []),
            purchases: 1,
            price: item.price,
            category: this.getCategoryIndex(item)
          });
          labels.push(1);
        });
      });
    }
    const products = JSON.parse(localStorage.getItem('products') || '[]');
    products.forEach(product => {
      if (!behavior.purchases?.some(p => p.items.some(i => i.id === product.id))) {
        data.push({
          views: behavior.productViews?.[product.id] || 0,
          searches: this.countRelatedSearches(product, behavior.searches || []),
          purchases: 0,
          price: product.price,
          category: this.getCategoryIndex(product)
        });
        labels.push(0);
      }
    });
    return { data, labels };
  }

  countRelatedSearches(product, searches) {
    return searches.filter(search =>
      product.name.toLowerCase().includes(search.term) ||
      (product.description && product.description.toLowerCase().includes(search.term))
    ).length;
  }

  getCategoryIndex(product) {
    const categories = ['เบรก', 'กรองอากาศ', 'น้ำมันเครื่อง', 'อื่นๆ'];
    const category = categories.findIndex(cat =>
      product.name.toLowerCase().includes(cat.toLowerCase())
    );
    return category === -1 ? categories.length - 1 : category;
  }

  async calculateProductScore(product, behavior) {
    let baseScore = await LocNetAI.prototype.calculateProductScore.call(this, product, behavior);
    try {
      const mlScore = await this.mlSystem.predict({
        views: behavior.productViews?.[product.id] || 0,
        searches: this.countRelatedSearches(product, behavior.searches || []),
        purchases: behavior.purchases?.filter(p => p.items.some(i => i.id === product.id)).length || 0,
        price: product.price,
        category: this.getCategoryIndex(product)
      });
      if (mlScore !== null) baseScore = baseScore * 0.7 + mlScore * 0.3;
    } catch (error) {
      console.error('Error getting ML score:', error);
    }
    return baseScore;
  }
}

/****************************************************
 * Initialize EmailJS
 ****************************************************/
if (typeof emailjs !== "undefined") {
  emailjs.init("qapab_Y_FJWHq8M1O"); // ใส่ Public Key ของคุณ
}

function sendOtpViaEmail(otpCode, toEmail) {
  return emailjs.send("service_v99cw1q", "template_wxe6t74", {
    to_email: toEmail,
    otp_code: otpCode,
  });
}

/****************************************************
 * Auth Supabase: Register, Login, Logout
 ****************************************************/
async function handleRegister(e) {
  e.preventDefault();
  console.log("Starting handleRegister");

  const username = document.getElementById("reg-username").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const phone = document.getElementById("reg-phone").value.trim();
  const address = document.getElementById("reg-address").value.trim();
  const pass = document.getElementById("reg-password").value;
  const pass2 = document.getElementById("reg-password-confirm").value;

  if (pass !== pass2) {
    console.log("Passwords do not match");
    alert("รหัสผ่านไม่ตรงกัน");
    return;
  }
  if (pass.length < 8) {
    console.log("Password too short");
    alert("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    return;
  }

  try {
    console.log("Attempting signUp with:", { email, password: pass });
    const { data, error: signUpError } = await window.supabase.auth.signUp({
      email,
      password: pass,
      options: {
        data: { username },
        emailRedirectTo: `${window.location.origin}`
      }
    });
    console.log("SignUp response:", { data, signUpError });
    if (signUpError) throw signUpError;
    const user = data.user;
    if (!user) throw new Error("ไม่สามารถสร้างผู้ใช้ได้");

    console.log("Inserting profile for user:", { id: user.id, username, email, phone, address });
    const { data: insertData, error: insertError } = await window.supabase
      .from("users")
      .insert([{ id: user.id, username, email, phone, address }]);
    console.log("Insert response:", { insertData, insertError });
    if (insertError) throw insertError;

    console.log("Registration complete for:", email);
    alert("สมัครสมาชิกสำเร็จ! คุณสามารถเข้าสู่ระบบได้ทันที");
    document.getElementById("registerForm").reset();
    closeModal();
  } catch (error) {
    console.error("Register Error:", error.message);
    alert("เกิดข้อผิดพลาดในการสมัครสมาชิก: " + error.message);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  console.log("Starting handleLogin");

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  if (!email || !password) {
    alert("กรุณากรอกอีเมลและรหัสผ่าน");
    return;
  }

  if (!window.supabase) {
    console.error("Supabase client ไม่ได้ถูกกำหนด");
    alert("ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองใหม่");
    return;
  }

  try {
    console.log("Attempting login with:", { email, password });
    const { data, error } = await window.supabase.auth.signInWithPassword({
      email,
      password,
    });
    console.log("Login response:", { data, error });
    if (error) throw error;
    if (!data.user) throw new Error("ไม่พบผู้ใช้");

    console.log("Login successful:", data.user);
    updateUIAfterLogin(data.user);
    closeModal();
    alert("เข้าสู่ระบบสำเร็จ!");
  } catch (error) {
    console.error("Login Error:", error.message);
    alert("อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง");
  }
}
window.handleLogin = handleLogin;

async function handleLogout() {
  await window.supabase.auth.signOut();
  document.getElementById("loginBtn").style.display = "inline-block";
  document.getElementById("logoutBtn").style.display = "none";
  document.getElementById("userGreeting").textContent = "";
  document.getElementById("profileBtn").style.display = "none";
  alert("ออกจากระบบเรียบร้อย");
  location.reload();
}
window.handleLogout = handleLogout;

async function updateUIAfterLogin(supabaseUser) {
  document.getElementById("loginBtn").style.display = "none";
  document.getElementById("logoutBtn").style.display = "inline-block";
  document.getElementById("profileBtn").style.display = "inline-block";

  const { data: userRow, error } = await window.supabase
    .from("users")
    .select("*")
    .eq("id", supabaseUser.id)
    .single();

  if (error || !userRow) {
    document.getElementById("userGreeting").textContent =
      "ยินดีต้อนรับ (user_id: " + supabaseUser.id + ")";
    return;
  }

  document.getElementById("userGreeting").textContent = `ยินดีต้อนรับ, ${userRow.username}`;
}

/****************************************************
 * Modal Auth แสดง/ปิด (ใช้ลิงก์จริงสำหรับ GitHub Pages)
 ****************************************************/
function openModal() {
  if (!localStorage.getItem("policyConsent")) {
    showPolicyPopup();
  } else {
    document.getElementById("authModal").style.display = "flex";
  }
}

function closeModal() {
  document.getElementById("authModal").style.display = "none";
}

function switchTab(e, tabName) {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((t) => t.classList.remove("active"));
  e.target.classList.add("active");
  document.getElementById("loginForm").style.display = tabName === "login" ? "block" : "none";
  document.getElementById("registerForm").style.display = tabName === "register" ? "block" : "none";
}

function showPolicyPopup() {
  const popup = document.createElement("div");
  popup.id = "policyPopup";
  popup.style.cssText = `
    position: fixed; 
    top: 50%; 
    left: 50%; 
    transform: translate(-50%, -50%); 
    background: #fff; 
    padding: 20px; 
    border-radius: 8px; 
    box-shadow: 0 2px 10px rgba(0,0,0,0.2); 
    z-index: 1001; 
    max-width: 600px; 
    font-family: 'Prompt', sans-serif;
  `;
  popup.innerHTML = `
    <h3 style="margin-top: 0;">ยินดีต้อนรับสู่ LocNet Auto Parts</h3>
    <p>ก่อนเข้าสู่ระบบ กรุณาอ่านและยอมรับนโยบายของเรา:</p>
    <ul>
      <li><a href="https://locnet96.github.io/LocNet/privacy-policy" target="_blank">นโยบายความเป็นส่วนตัว (Privacy Policy)</a></li>
      <li><a href="https://locnet96.github.io/LocNet/cookies-policy" target="_blank">นโยบายการใช้คุกกี้ (Cookies Policy)</a></li>
    </ul>
    <p>การกด "ยอมรับ" ถือว่าท่านยินยอมให้เราเก็บรวบรวมและใช้ข้อมูลส่วนบุคคลตามนโยบายดังกล่าว</p>
    <div style="margin-top: 10px; text-align: center;">
      <button id="acceptPolicy" style="background: #007bff; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">ยอมรับ</button>
      <button id="declinePolicy" style="background: #dc3545; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-left: 10px;">ปฏิเสธ</button>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("acceptPolicy").addEventListener("click", () => {
    localStorage.setItem("policyConsent", "accepted");
    document.getElementById("policyPopup").remove();
    document.getElementById("authModal").style.display = "flex";
  });

  document.getElementById("declinePolicy").addEventListener("click", () => {
    document.getElementById("policyPopup").remove();
    alert("ท่านต้องยอมรับนโยบายเพื่อใช้งานระบบล็อกอิน");
  });
}

window.openModal = openModal;
window.closeModal = closeModal;
window.switchTab = switchTab;

window.addEventListener("click", function(event) {
  const authModal = document.getElementById("authModal");
  if (event.target === authModal) closeModal();
});

/****************************************************
 * ป๊อปอัปยินยอมคุกกี้
 ****************************************************/
document.addEventListener("DOMContentLoaded", () => {
  if (!localStorage.getItem("cookieConsent")) {
    showCookiePopup();
  }
});

function showCookiePopup() {
  const popup = document.createElement("div");
  popup.id = "cookiePopup";
  popup.style.cssText = `
    position: fixed; 
    bottom: 20px; 
    left: 20px; 
    right: 20px; 
    background: #fff; 
    padding: 20px; 
    border-radius: 8px; 
    box-shadow: 0 2px 10px rgba(0,0,0,0.2); 
    z-index: 1000; 
    max-width: 500px; 
    font-family: 'Prompt', sans-serif;
  `;
  popup.innerHTML = `
    <h3 style="margin-top: 0;">เราใช้คุกกี้</h3>
    <p>เราใช้คุกกี้เพื่อมอบประสบการณ์ที่ดีที่สุดบนเว็บไซต์ LocNet Auto Parts รวมถึงการทำงานพื้นฐาน การวิเคราะห์ และการตลาด <a href="https://locnet96.github.io/LocNet/cookies-policy" target="_blank">เรียนรู้เพิ่มเติม</a></p>
    <div style="margin: 10px 0;">
      <button id="acceptAllCookies" style="background: #007bff; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">ยอมรับทั้งหมด</button>
      <button id="cookieSettings" style="background: transparent; color: #007bff; border: none; padding: 8px 16px; cursor: pointer;">ตั้งค่า</button>
    </div>
    <div id="cookieOptions" style="display: none;">
      <label style="display: block; margin: 10px 0;">
        <input type="checkbox" id="necessaryCookies" checked disabled> คุกกี้ที่จำเป็น (ไม่สามารถปิดได้)
      </label>
      <label style="display: block; margin: 10px 0;">
        <input type="checkbox" id="preferencesCookies"> คุกกี้เพื่อการตั้งค่า
      </label>
      <label style="display: block; margin: 10px 0;">
        <input type="checkbox" id="statisticsCookies"> คุกกี้เพื่อการวิเคราะห์
      </label>
      <label style="display: block; margin: 10px 0;">
        <input type="checkbox" id="marketingCookies"> คุกกี้เพื่อการตลาด
      </label>
      <button id="saveCookieSettings" style="background: #28a745; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">บันทึก</button>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("acceptAllCookies").addEventListener("click", acceptAllCookies);
  document.getElementById("cookieSettings").addEventListener("click", showCookieSettings);
  document.getElementById("saveCookieSettings").addEventListener("click", saveCookieSettings);
}

function acceptAllCookies() {
  localStorage.setItem("cookieConsent", JSON.stringify({
    necessary: true,
    preferences: true,
    statistics: true,
    marketing: true
  }));
  document.getElementById("cookiePopup").remove();
}

function showCookieSettings() {
  document.getElementById("cookieOptions").style.display = "block";
  document.getElementById("cookieSettings").style.display = "none";
}

function saveCookieSettings() {
  const settings = {
    necessary: true,
    preferences: document.getElementById("preferencesCookies").checked,
    statistics: document.getElementById("statisticsCookies").checked,
    marketing: document.getElementById("marketingCookies").checked
  };
  localStorage.setItem("cookieConsent", JSON.stringify(settings));
  document.getElementById("cookiePopup").remove();
  applyCookieSettings(settings);
}

function applyCookieSettings(settings) {
  if (!settings.preferences) {
    document.cookie = "theme_preference=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  }
  if (!settings.statistics) {
    if (window.ga) window.ga("set", "anonymizeIp", true);
  }
  if (!settings.marketing) {
    document.cookie = "affiliate_tracker=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  }
}

const savedConsent = localStorage.getItem("cookieConsent");
if (savedConsent) {
  applyCookieSettings(JSON.parse(savedConsent));
}

/****************************************************
 * Forgot Password + OTP
 ****************************************************/
function createForgotPasswordModal() {
  let modal = document.getElementById("forgotPasswordModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "forgotPasswordModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content">
        <span class="close-forgot" style="cursor:pointer; font-size:1.5rem;">&times;</span>
        <h2>รีเซ็ตรหัสผ่าน (OTP)</h2>
        <form id="forgotPasswordForm">
          <div class="form-group">
            <label>อีเมล</label>
            <input type="email" id="fp-email" required>
          </div>
          <div class="form-group">
            <label>ขอรหัส OTP</label>
            <button type="button" class="btn-secondary" id="generateOtpBtn">ขอ OTP</button>
          </div>
          <div class="form-group">
            <label>OTP ที่ได้รับ</label>
            <input type="text" id="fp-otp" placeholder="กรอกรหัสที่ได้" required>
          </div>
          <div class="form-group">
            <label>รหัสผ่านใหม่</label>
            <input type="password" id="fp-new-password" required>
          </div>
          <div class="form-group">
            <label>ยืนยันรหัสผ่านใหม่</label>
            <input type="password" id="fp-confirm-password" required>
          </div>
          <button type="submit" class="btn-primary">รีเซ็ตรหัสผ่าน</button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector(".close-forgot").addEventListener("click", closeForgotPasswordModal);
    document.getElementById("forgotPasswordForm").addEventListener("submit", handleForgotPasswordSubmission);
    modal.querySelector("#generateOtpBtn").addEventListener("click", (e) => {
      e.preventDefault();
      generateOtpForUser();
    });

    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeForgotPasswordModal();
    });
  }
  return modal;
}

function openForgotPasswordModal() {
  const modal = createForgotPasswordModal();
  modal.style.display = "flex";
}

function closeForgotPasswordModal() {
  const modal = document.getElementById("forgotPasswordModal");
  if (modal) modal.style.display = "none";
}

async function generateOtpForUser() {
  const email = document.getElementById("fp-email").value.trim().toLowerCase();
  if (!email) {
    alert("กรุณากรอกอีเมลก่อนขอ OTP");
    return;
  }

  const { data: userRow, error } = await window.supabase
    .from("users")
    .select("id, email")
    .eq("email", email)
    .single();

  if (error || !userRow) {
    alert("ไม่พบอีเมลนี้ในระบบ");
    return;
  }

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expireTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error: updateError } = await window.supabase
    .from("users")
    .update({ reset_otp: otpCode, reset_otp_expire: expireTime })
    .eq("id", userRow.id);

  if (updateError) {
    alert("ไม่สามารถตั้งค่า OTP ได้: " + updateError.message);
    return;
  }

  sendOtpViaEmail(otpCode, email)
    .then(() => alert(`ระบบได้ส่ง OTP ไปทางอีเมล ${email} แล้ว (มีอายุ 5 นาที)`))
    .catch((err) => {
      console.error("Error sending OTP email:", err);
      alert("ไม่สามารถส่งอีเมลได้ กรุณาลองใหม่หรือติดต่อผู้ดูแลระบบ");
    });
}

async function handleForgotPasswordSubmission(e) {
  e.preventDefault();

  const email = document.getElementById("fp-email").value.trim().toLowerCase();
  const otpInput = document.getElementById("fp-otp").value.trim();
  const newPassword = document.getElementById("fp-new-password").value;
  const confirmPassword = document.getElementById("fp-confirm-password").value;

  if (newPassword !== confirmPassword) {
    alert("รหัสผ่านใหม่และยืนยันไม่ตรงกัน");
    return;
  }

  const { data: userRow, error } = await window.supabase
    .from("users")
    .select("id, reset_otp, reset_otp_expire")
    .eq("email", email)
    .single();

  if (error || !userRow) {
    alert("ไม่พบอีเมลนี้ในระบบ");
    return;
  }

  if (!userRow.reset_otp || !userRow.reset_otp_expire) {
    alert("กรุณากดขอรหัส OTP ก่อน");
    return;
  }

  const now = new Date();
  const expireTime = new Date(userRow.reset_otp_expire);
  if (now > expireTime) {
    alert("OTP หมดอายุแล้ว กรุณาขอใหม่");
    return;
  }

  if (userRow.reset_otp !== otpInput) {
    alert("OTP ไม่ถูกต้อง");
    return;
  }

  const { error: updateAuthErr } = await window.supabase.auth.updateUser({
    password: newPassword,
  });
  if (updateAuthErr) {
    alert("ไม่สามารถรีเซ็ตรหัสผ่านได้: " + updateAuthErr.message);
    return;
  }

  await window.supabase
    .from("users")
    .update({ reset_otp: null, reset_otp_expire: null })
    .eq("id", userRow.id);

  alert("รีเซ็ตรหัสผ่านสำเร็จ! กรุณาเข้าสู่ระบบด้วยรหัสใหม่");
  document.getElementById("forgotPasswordForm").reset();
  closeForgotPasswordModal();
}

/****************************************************
 * Discord Notification
 ****************************************************/
async function sendToDiscord(cart, total, orderDetails, slipFile) {
  const DISCORD_WEBHOOK_URL =
    "https://discord.com/api/webhooks/1336992146145673257/_ednBAPdn4Bo9ml2MkcLJQoGzaNBxMKveJqMBksdWmWpE5MIFzaOGepODtCheOHqZYLv";
  const thaiDateTime = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const embed = {
    title: "🛒 มีคำสั่งซื้อใหม่เข้ามา!",
    color: 0xff8c00,
    fields: [
      {
        name: "📋 รายการสินค้า",
        value:
          cart && cart.length > 0
            ? cart.map((item) => `• ${escapeHTML(item.name)}\n   จำนวน: ${item.quantity} ชิ้น = ${item.price * item.quantity} บาท`).join("\n")
            : "ไม่มีรายการ",
      },
      { name: "💰 ยอดรวมทั้งสิ้น", value: `${total} บาท`, inline: true },
      { name: "💳 ชำระโดย", value: orderDetails.paymentMethod, inline: true },
      {
        name: "👤 ข้อมูลผู้สั่ง",
        value: `ชื่อ: ${escapeHTML(orderDetails.address.fullName)}\nเบอร์โทร: ${escapeHTML(orderDetails.address.phone)}\nที่อยู่: ${escapeHTML(orderDetails.address.address)}\n${orderDetails.address.note ? "หมายเหตุ: " + escapeHTML(orderDetails.address.note) : ""}`,
      },
    ],
    footer: { text: `สั่งซื้อเมื่อ: ${thaiDateTime}` },
  };

  try {
    if (slipFile) {
      const formData = new FormData();
      formData.append("file", slipFile, slipFile.name);
      embed.image = { url: `attachment://${slipFile.name}` };
      const payload = {
        username: "LocNet Auto Parts",
        avatar_url: "https://i.imgur.com/AfFp7pu.png",
        embeds: [embed],
      };
      formData.append("payload_json", JSON.stringify(payload));
      const response = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: formData });
      if (!response.ok) throw new Error("ไม่สามารถส่งข้อมูลไปยัง Discord ได้");
    } else {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "LocNet Auto Parts",
          avatar_url: "https://i.imgur.com/AfFp7pu.png",
          embeds: [embed],
        }),
      });
      if (!response.ok) throw new Error("ไม่สามารถส่งข้อมูลไปยัง Discord ได้");
    }
  } catch (error) {
    console.error("เกิดข้อผิดพลาดในการส่งข้อมูล:", error);
  }
}

/****************************************************
 * Cart Functions
 ****************************************************/
function toggleCart() {
  const cartSidebar = document.getElementById("cartSidebar");
  cartSidebar.classList.toggle("open");
  renderCartItems();
}
window.toggleCart = toggleCart;

async function addToCart(productId) {
  const user = await getCurrentUser();
  if (!user) {
    alert("กรุณาเข้าสู่ระบบก่อนเพิ่มสินค้า");
    openModal();
    return;
  }

  const { data: existing } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id)
    .eq("product_id", productId)
    .maybeSingle();

  let newQty = 1;
  if (existing) newQty = existing.quantity + 1;

  const { error: upsertError } = await window.supabase
    .from("cart")
    .upsert({
      id: existing ? existing.id : undefined,
      user_id: user.id,
      product_id: productId,
      quantity: newQty,
    })
    .eq("user_id", user.id)
    .eq("product_id", productId);

  if (upsertError) {
    alert("ไม่สามารถเพิ่มสินค้าลงตะกร้าได้: " + upsertError.message);
    return;
  }

  alert("เพิ่มสินค้าลงตะกร้าแล้ว");
  updateCartCount();
}

async function renderCartItems() {
  const cartItemsDiv = document.getElementById("cartItems");
  cartItemsDiv.innerHTML = "";
  let total = 0;

  const user = await getCurrentUser();
  if (!user) {
    document.getElementById("cartTotal").textContent = "฿0.00";
    return;
  }

  const { data: cartRows, error: cartError } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id);

  if (cartError || !cartRows) {
    document.getElementById("cartTotal").textContent = "฿0.00";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let item of cartRows) {
    const { data: productData } = await window.supabase
      .from("products")
      .select("*")
      .eq("id", item.product_id)
      .single();

    if (!productData) continue;
    const sum = Number(productData.price) * item.quantity;
    total += sum;

    const div = document.createElement("div");
    div.classList.add("cart-item");
    div.innerHTML = `
      <img src="${validateImageURL(productData.image_url)}" alt="${escapeHTML(productData.name)}" loading="lazy">
      <div>
        <h4>${escapeHTML(productData.name)}</h4>
        <p>ราคา: ฿${productData.price}</p>
        <p>จำนวน:
          <button class="btn-decrease" data-pid="${item.product_id}">-</button>
          ${item.quantity}
          <button class="btn-increase" data-pid="${item.product_id}">+</button>
        </p>
      </div>
      <div>
        <p>รวม: ฿${sum.toFixed(2)}</p>
        <button class="btn-remove" data-pid="${item.product_id}" style="color:red; border:none; background:none; cursor:pointer;">ลบ</button>
      </div>
    `;
    fragment.appendChild(div);
  }

  cartItemsDiv.appendChild(fragment);
  document.getElementById("cartTotal").textContent = "฿" + total.toFixed(2);
}

async function updateCartCount() {
  const cartCount = document.querySelector(".cart-count");
  let qty = 0;
  const user = await getCurrentUser();
  if (!user) {
    cartCount.textContent = 0;
    return;
  }

  const { data: cartRows } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id);

  if (cartRows && cartRows.length > 0) {
    cartRows.forEach((item) => qty += item.quantity);
  }
  cartCount.textContent = qty;
}

async function increaseQuantity(productId) {
  const user = await getCurrentUser();
  if (!user) return;

  const { data: cartItem } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id)
    .eq("product_id", productId)
    .single();

  if (!cartItem) return;
  const newQty = cartItem.quantity + 1;

  await window.supabase.from("cart").update({ quantity: newQty }).eq("id", cartItem.id);
  renderCartItems();
  updateCartCount();
}

async function decreaseQuantity(productId) {
  const user = await getCurrentUser();
  if (!user) return;

  const { data: cartItem } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id)
    .eq("product_id", productId)
    .single();

  if (!cartItem) return;
  let newQty = cartItem.quantity - 1;
  if (newQty < 1) newQty = 1;

  await window.supabase.from("cart").update({ quantity: newQty }).eq("id", cartItem.id);
  renderCartItems();
  updateCartCount();
}

async function removeItem(productId) {
  const user = await getCurrentUser();
  if (!user) return;

  await window.supabase.from("cart").delete().eq("user_id", user.id).eq("product_id", productId);
  renderCartItems();
  updateCartCount();
}

/****************************************************
 * Checkout & Payment
 ****************************************************/
let pendingCart = null;
let pendingOrder = null;

async function checkout() {
  const user = await getCurrentUser();
  if (!user) {
    alert("กรุณาเข้าสู่ระบบก่อนทำการสั่งซื้อ");
    openModal();
    return;
  }

  const { data: cartRows } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id);
  if (!cartRows || cartRows.length === 0) {
    alert("ตะกร้าสินค้าว่าง");
    return;
  }

  openCheckoutModal();
}
window.checkout = checkout;

async function openCheckoutModal() {
  const user = await getCurrentUser();
  if (user) {
    const { data: profile } = await window.supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profile) {
      document.getElementById("checkoutFullName").value = profile.username || "";
      document.getElementById("checkoutPhone").value = profile.phone || "";
      document.getElementById("checkoutAddress").value = profile.address || "";
    }
  }
  document.getElementById("checkoutModal").style.display = "flex";
}

function closeCheckoutModal() {
  document.getElementById("checkoutModal").style.display = "none";
}
window.closeCheckoutModal = closeCheckoutModal;

async function confirmCheckout(e) {
  e.preventDefault();
  const fullName = document.getElementById("checkoutFullName").value.trim();
  const phone = document.getElementById("checkoutPhone").value.trim();
  const addressText = document.getElementById("checkoutAddress").value.trim();
  const note = document.getElementById("checkoutNote").value.trim();
  const payment = document.getElementById("checkoutPayment").value;

  const user = await getCurrentUser();
  if (!user) return;

  const { data: cartRows } = await window.supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id);
  if (!cartRows || cartRows.length === 0) {
    alert("ไม่พบรายการสินค้า");
    return;
  }

  let cartDetail = [];
  let total = 0;
  for (let c of cartRows) {
    const { data: productData } = await window.supabase
      .from("products")
      .select("*")
      .eq("id", c.product_id)
      .single();
    if (!productData) continue;
    const sum = Number(productData.price) * c.quantity;
    total += sum;
    cartDetail.push({
      id: productData.id,
      name: productData.name,
      price: Number(productData.price),
      quantity: c.quantity,
    });
  }

  pendingCart = cartDetail;
  pendingOrder = {
    paymentMethod: payment,
    address: { fullName, phone, address: addressText, note },
  };

  await window.supabase.from("cart").delete().eq("user_id", user.id);
  updateCartCount();
  renderCartItems();
  closeCheckoutModal();
  toggleCart();

  if (payment === "โอนผ่านธนาคาร") {
    openPaymentModal();
  } else {
    sendToDiscord(pendingCart, total, pendingOrder, null);
    alert("สั่งซื้อเรียบร้อย! ระบบได้รับคำสั่งซื้อแล้ว");
    pendingCart = null;
    pendingOrder = null;
  }
}
window.confirmCheckout = confirmCheckout;

function createPaymentModal() {
  let modal = document.getElementById("paymentModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "paymentModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content payment-content">
        <span class="close-payment" style="cursor:pointer; font-size:1.5rem;">&times;</span>
        <h2>ชำระเงินด้วยการโอนผ่านธนาคาร</h2>
        <p>กรุณาโอนเงินไปที่บัญชีธนาคารด้านล่าง:</p>
        <ul>
          <li>ธนาคาร: กสิกรไทย</li>
          <li>ชื่อบัญชี: LocNet Auto Parts</li>
          <li>เลขที่บัญชี: 123-456-7890</li>
        </ul>
        <p>หลังจากโอนเงินแล้ว กรุณาอัปโหลดรูปภาพหลักฐานการโอน:</p>
        <input type="file" id="bankSlip" accept="image/*" />
        <br><br>
        <button id="confirmPaymentBtn" class="btn-primary">ยืนยันการชำระเงิน</button>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector(".close-payment").addEventListener("click", closePaymentModal);
    modal.querySelector("#confirmPaymentBtn").addEventListener("click", handleConfirmPayment);

    modal.addEventListener("click", function (e) {
      if (e.target === modal) closePaymentModal();
    });
  }
  return modal;
}

function openPaymentModal() {
  const modal = createPaymentModal();
  modal.style.display = "flex";
}

function closePaymentModal() {
  const modal = document.getElementById("paymentModal");
  if (modal) modal.style.display = "none";
}

async function handleConfirmPayment() {
  const slipInput = document.getElementById("bankSlip");
  let slipFile = null;
  if (slipInput.files && slipInput.files[0]) slipFile = slipInput.files[0];

  if (!pendingCart || !pendingOrder) {
    alert("ไม่พบข้อมูลออเดอร์ กรุณาสั่งซื้อใหม่");
    closePaymentModal();
    return;
  }

  let total = 0;
  pendingCart.forEach((item) => total += item.price * item.quantity);

  await sendToDiscord(pendingCart, total, pendingOrder, slipFile);
  alert("การชำระเงินสำเร็จ! ทางเราจะตรวจสอบภายใน 24 ชั่วโมง");
  closePaymentModal();
  pendingCart = null;
  pendingOrder = null;
}

/****************************************************
 * Product Functions
 ****************************************************/
async function loadProducts() {
  if (!window.supabase) {
    console.error('Supabase not initialized');
    return [];
  }
  await ensureSupabase();
  try {
    const { data: products, error } = await window.supabase.from("products").select("*");
    if (error) throw error;
    return products;
  } catch (err) {
    console.error('Error loading products:', err);
    return [];
  }
}
async function renderProductsList(products) {
  const productsGrid = document.getElementById("productsGrid");
  productsGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();

  products.forEach((p) => {
    const card = document.createElement("div");
    card.classList.add("product-card");
    card.innerHTML = `
      <img src="${validateImageURL(p.image_url || "")}" alt="${escapeHTML(p.name)}" class="product-image" data-product-id="${p.id}" loading="lazy">
      <div class="product-info">
        <h3>${escapeHTML(p.name)}</h3>
        <p>${escapeHTML(p.description || "")}</p>
        <div class="product-price">฿${p.price}</div>
      </div>
      <div class="product-actions">
        <a href="#" class="action-button action-view-detail" data-product-id="${p.id}">
          <i class="fas fa-search"></i> ดูรายละเอียด
        </a>
        <a href="#" class="action-button action-add-to-cart" data-product-id="${p.id}">
          <i class="fas fa-shopping-cart"></i> เพิ่มลงตะกร้า
        </a>
        <a href="#" class="action-button action-like" data-product-id="${p.id}">
          <i class="fas fa-heart"></i> ถูกใจ
        </a>
      </div>
    `;
    fragment.appendChild(card);
  });

  productsGrid.appendChild(fragment);
}

async function renderProducts() {
  const products = await loadProducts();
  renderProductsList(products);
}

async function getAIRecommendations() {
  const products = await loadProducts();
  if (!products.length) return [];
  const shuffled = [...products].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 2);
}

async function renderAIRecommendations() {
  const aiGrid = document.getElementById("aiRecommendGrid");
  if (!aiGrid) return;
  aiGrid.innerHTML = "";
  const recs = await getAIRecommendations();
  const fragment = document.createDocumentFragment();

  recs.forEach((p) => {
    const card = document.createElement("div");
    card.classList.add("product-card");
    card.innerHTML = `
      <img src="${validateImageURL(p.image_url || "")}" alt="${escapeHTML(p.name)}" class="product-image" data-product-id="${p.id}" loading="lazy">
      <div class="product-info">
        <h3>${escapeHTML(p.name)}</h3>
        <p>${escapeHTML(p.description || "")}</p>
        <div class="product-price">฿${p.price}</div>
      </div>
      <div class="product-actions">
        <a href="#" class="action-button action-view-detail" data-product-id="${p.id}">
          <i class="fas fa-search"></i> ดูรายละเอียด
        </a>
        <a href="#" class="action-button action-add-to-cart" data-product-id="${p.id}">
          <i class="fas fa-shopping-cart"></i> เพิ่มลงตะกร้า
        </a>
        <a href="#" class="action-button action-like" data-product-id="${p.id}">
          <i class="fas fa-heart"></i> ถูกใจ
        </a>
      </div>
    `;
    fragment.appendChild(card);
  });

  aiGrid.appendChild(fragment);
}

async function openProductDetail(productId) {
  const products = await loadProducts();
  const product = products.find((p) => p.id === productId);
  if (product) {
    document.getElementById("detailImage").src = validateImageURL(product.image_url || "");
    document.getElementById("detailName").textContent = product.name;
    document.getElementById("detailDesc").textContent = product.description || "";
    document.getElementById("detailPrice").textContent = "฿" + product.price;
    document.getElementById("addToCartFromDetail").setAttribute("data-product-id", product.id);
    document.getElementById("productDetailModal").style.display = "flex";
  }
}

function closeProductDetail() {
  document.getElementById("productDetailModal").style.display = "none";
}
window.closeProductDetail = closeProductDetail;

document.getElementById("addToCartFromDetail").addEventListener("click", function (e) {
  const productId = e.target.getAttribute("data-product-id");
  addToCart(productId);
  closeProductDetail();
});

async function toggleLike(productId, btnElement) {
  const user = await getCurrentUser();
  if (!user) {
    alert("กรุณาเข้าสู่ระบบก่อนทำรายการ");
    openModal();
    return;
  }

  const { data: row } = await window.supabase
    .from("wishlist")
    .select("*")
    .eq("user_id", user.id)
    .eq("product_id", productId)
    .maybeSingle();

  if (row) {
    await window.supabase.from("wishlist").delete().eq("user_id", user.id).eq("product_id", productId);
    alert("นำออกจากรายการถูกใจแล้ว");
    btnElement.classList.remove("liked");
  } else {
    await window.supabase.from("wishlist").insert({ user_id: user.id, product_id: productId });
    alert("เพิ่มลงในรายการถูกใจแล้ว");
    btnElement.classList.add("liked");
  }
}

/****************************************************
 * Dark Mode Toggle
 ****************************************************/
function toggleTheme() {
  document.body.classList.toggle("dark-mode");
  const themeToggleBtn = document.getElementById("themeToggle");
  if (document.body.classList.contains("dark-mode")) {
    themeToggleBtn.innerHTML = '<i class="fas fa-sun"></i> โหมดสว่าง';
  } else {
    themeToggleBtn.innerHTML = '<i class="fas fa-adjust"></i> โหมดมืด';
  }
}
window.toggleTheme = toggleTheme;

/****************************************************
 * Admin Panel
 ****************************************************/
let editingProductId = null;

function openAdminPanel() {
  const pass = prompt("กรุณาใส่รหัสผ่านสำหรับ Admin:");
  if (pass === "Me2934") {
    document.getElementById("adminPanel").style.display = "flex";
    document.getElementById("productForm").reset();
    document.getElementById("editProductId").value = "";
    document.getElementById("adminTitle").textContent = "เพิ่ม/แก้ไข สินค้า";
    document.getElementById("productFormBtn").textContent = "บันทึกสินค้า";
    editingProductId = null;
    renderAdminProductList();
  } else {
    if (pass !== null) alert("รหัสผ่านไม่ถูกต้อง!");
  }
}

function closeAdminPanel() {
  document.getElementById("adminPanel").style.display = "none";
}

async function renderAdminProductList() {
    const adminList = document.getElementById("adminProductList");
    adminList.innerHTML = "";
    const products = await loadProducts();
  
    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.innerHTML = `
      <thead>
        <tr style="background:#f0f0f0">
          <th style="padding:8px;">ID</th>
          <th style="padding:8px;">สินค้า</th>
          <th style="padding:8px;">ราคา</th>
          <th style="padding:8px;">แก้ไข</th>
          <th style="padding:8px;">ลบ</th>
        </tr>
      </thead>
      <tbody id="adminTableBody"></tbody>
    `;
  
    adminList.appendChild(table);
    const tbody = document.getElementById("adminTableBody");
  
    products.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="padding:8px;">${p.id}</td>
        <td style="padding:8px;">
          <strong>${escapeHTML(p.name)}</strong><br/>
          <small>${escapeHTML(p.description || "")}</small>
        </td>
        <td style="padding:8px;">฿${p.price}</td>
        <td style="padding:8px;">
          <button class="btn-secondary" onclick="editProduct('${p.id}')">แก้ไข</button>
        </td>
        <td style="padding:8px;">
          <button class="btn-danger" onclick="deleteProduct('${p.id}')">ลบ</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }
  
  async function editProduct(productId) {
    const products = await loadProducts();
    const prod = products.find((x) => x.id === productId);
    if (!prod) return;
    editingProductId = prod.id;
    document.getElementById("editProductId").value = prod.id;
    document.getElementById("productName").value = prod.name;
    document.getElementById("productDesc").value = prod.description || "";
    document.getElementById("productPrice").value = prod.price;
    document.getElementById("adminTitle").textContent = "แก้ไขสินค้า";
    document.getElementById("productFormBtn").textContent = "บันทึกการแก้ไข";
  }
  
  async function handleProductSubmit(e) {
    e.preventDefault();
  
    const name = document.getElementById("productName").value.trim();
    const description = document.getElementById("productDesc").value.trim();
    const price = document.getElementById("productPrice").value.trim();
    const imageFile = document.getElementById("productImage").files[0];
  
    if (!name || !price) {
      alert("กรุณากรอกข้อมูลสินค้าให้ครบ");
      return;
    }
  
    if (editingProductId) {
      // แก้ไขสินค้า
      let base64Image;
      if (imageFile) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          base64Image = event.target.result;
          const { error } = await window.supabase
            .from("products")
            .update({ name, description, price: Number(price), image_url: base64Image })
            .eq("id", editingProductId);
  
          if (error) {
            alert("แก้ไขสินค้าไม่สำเร็จ: " + error.message);
            return;
          }
          alert("แก้ไขสินค้าเรียบร้อย");
          renderProducts();
          renderAdminProductList();
          e.target.reset();
          editingProductId = null;
          document.getElementById("editProductId").value = "";
          document.getElementById("adminTitle").textContent = "เพิ่ม/แก้ไข สินค้า";
          document.getElementById("productFormBtn").textContent = "บันทึกสินค้า";
        };
        reader.readAsDataURL(imageFile);
      } else {
        const { error } = await window.supabase
          .from("products")
          .update({ name, description, price: Number(price) })
          .eq("id", editingProductId);
  
        if (error) {
          alert("แก้ไขสินค้าไม่สำเร็จ: " + error.message);
          return;
        }
        alert("แก้ไขสินค้าเรียบร้อย");
        renderProducts();
        renderAdminProductList();
        e.target.reset();
        editingProductId = null;
        document.getElementById("editProductId").value = "";
        document.getElementById("adminTitle").textContent = "เพิ่ม/แก้ไข สินค้า";
        document.getElementById("productFormBtn").textContent = "บันทึกสินค้า";
      }
    } else {
      // เพิ่มสินค้าใหม่
      if (!imageFile) {
        alert("กรุณาอัปโหลดรูปสินค้า");
        return;
      }
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Image = event.target.result;
        const { error } = await window.supabase.from("products").insert({
          name,
          description,
          price: Number(price),
          image_url: base64Image,
        });
  
        if (error) {
          alert("เพิ่มสินค้าไม่สำเร็จ: " + error.message);
          return;
        }
        alert("เพิ่มสินค้าเรียบร้อย");
        renderProducts();
        renderAdminProductList();
        e.target.reset();
      };
      reader.readAsDataURL(imageFile);
    }
  }
  
  async function deleteProduct(id) {
    if (!confirm("คุณต้องการลบสินค้านี้หรือไม่?")) return;
    const { error } = await window.supabase.from("products").delete().eq("id", id);
    if (error) {
      alert("ลบสินค้าไม่สำเร็จ: " + error.message);
      return;
    }
    alert("ลบสินค้าเรียบร้อย");
    renderProducts();
    renderAdminProductList();
  }
  
  window.openAdminPanel = openAdminPanel;
  window.closeAdminPanel = closeAdminPanel;
  
  /****************************************************
   * Event Delegation: Products Grid, AI Grid, Cart Items
   ****************************************************/
  document.getElementById("productsGrid").addEventListener("click", function (e) {
    const viewBtn = e.target.closest(".action-view-detail");
    if (viewBtn) {
      e.preventDefault();
      const productId = viewBtn.getAttribute("data-product-id");
      openProductDetail(productId);
      return;
    }
    const addBtn = e.target.closest(".action-add-to-cart");
    if (addBtn) {
      e.preventDefault();
      const productId = addBtn.getAttribute("data-product-id");
      addToCart(productId);
      return;
    }
    const likeBtn = e.target.closest(".action-like");
    if (likeBtn) {
      e.preventDefault();
      const productId = likeBtn.getAttribute("data-product-id");
      toggleLike(productId, likeBtn);
      return;
    }
  });
  
  document.getElementById("aiRecommendGrid").addEventListener("click", function (e) {
    const viewBtn = e.target.closest(".action-view-detail");
    if (viewBtn) {
      e.preventDefault();
      const productId = viewBtn.getAttribute("data-product-id");
      openProductDetail(productId);
      return;
    }
    const addBtn = e.target.closest(".action-add-to-cart");
    if (addBtn) {
      e.preventDefault();
      const productId = addBtn.getAttribute("data-product-id");
      addToCart(productId);
      return;
    }
    const likeBtn = e.target.closest(".action-like");
    if (likeBtn) {
      e.preventDefault();
      const productId = likeBtn.getAttribute("data-product-id");
      toggleLike(productId, likeBtn);
      return;
    }
  });
  
  document.getElementById("cartItems").addEventListener("click", function (e) {
    if (e.target.closest(".btn-decrease")) {
      e.preventDefault();
      const productId = e.target.closest(".btn-decrease").getAttribute("data-pid");
      decreaseQuantity(productId);
    }
    if (e.target.closest(".btn-increase")) {
      e.preventDefault();
      const productId = e.target.closest(".btn-increase").getAttribute("data-pid");
      increaseQuantity(productId);
    }
    if (e.target.closest(".btn-remove")) {
      e.preventDefault();
      const productId = e.target.closest(".btn-remove").getAttribute("data-pid");
      removeItem(productId);
    }
  });
  
  /****************************************************
   * Search & Filter
   ****************************************************/
  async function handleSearch() {
    const searchInput = document.querySelector('.filter-group input[type="text"]');
    const query = searchInput.value.trim().toLowerCase();
    const products = await loadProducts();
    if (!query) {
      renderProductsList(products);
      return;
    }
    const filtered = products.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.description || "").toLowerCase().includes(query) ||
        p.id.toString().includes(query)
    );
    renderProductsList(filtered);
  }
  
  async function handleFilter() {
    const priceSlider = document.querySelector('.price-range input[type="range"]');
    const maxPrice = parseFloat(priceSlider.value);
  
    let allProducts = await loadProducts();
    let filtered = allProducts.filter((p) => parseFloat(p.price) <= maxPrice);
  
    const categoryCheckboxes = document.querySelectorAll(".filter-category:nth-of-type(2) input[type='checkbox']");
    const selectedCategories = [];
    categoryCheckboxes.forEach((chk) => {
      if (chk.checked) {
        const label = chk.parentElement.textContent.trim();
        selectedCategories.push(label.toLowerCase());
      }
    });
    if (selectedCategories.length > 0) {
      filtered = filtered.filter((p) =>
        selectedCategories.some((cat) => (p.category || "").toLowerCase().includes(cat))
      );
    }
  
    const brandCheckboxes = document.querySelectorAll(".filter-category:nth-of-type(3) input[type='checkbox']");
    const selectedBrands = [];
    brandCheckboxes.forEach((chk) => {
      if (chk.checked) {
        const label = chk.parentElement.textContent.trim();
        selectedBrands.push(label.toLowerCase());
      }
    });
    if (selectedBrands.length > 0) {
      filtered = filtered.filter((p) =>
        selectedBrands.some((b) => (p.description || "").toLowerCase().includes(b))
      );
    }
  
    renderProductsList(filtered);
  }
  
  const searchInputField = document.querySelector('.filter-group input[type="text"]');
  if (searchInputField) {
    searchInputField.addEventListener("input", handleSearch);
  }
  
  function updatePriceDisplay() {
    const priceSlider = document.querySelector('.price-range input[type="range"]');
    const priceDisplay = document.getElementById("currentPrice");
    if (priceSlider && priceDisplay) {
      priceDisplay.textContent = "฿" + priceSlider.value;
    }
  }
  
  const priceSlider = document.querySelector('.price-range input[type="range"]');
  if (priceSlider) {
    priceSlider.value = priceSlider.getAttribute("max") || 50000;
    priceSlider.addEventListener("input", function () {
      updatePriceDisplay();
      handleFilter();
    });
    updatePriceDisplay();
  }
  
  const filterCheckboxes = document.querySelectorAll(".filter-category input[type='checkbox']");
  filterCheckboxes.forEach((chk) => {
    chk.addEventListener("change", handleFilter);
  });
  
  /****************************************************
   * Profile Management Functions
   ****************************************************/
  async function openUserProfile() {
    const user = await getCurrentUser();
    if (!user) {
      alert("กรุณาเข้าสู่ระบบก่อนเข้าถึงข้อมูลส่วนตัว");
      openModal();
      return;
    }
  
    const { data: profile } = await window.supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();
  
    if (profile) {
      document.getElementById("profile-username").value = profile.username || "";
      document.getElementById("profile-email").value = profile.email || "";
      document.getElementById("profile-email").setAttribute("readonly", true);
      document.getElementById("profile-phone").value = profile.phone || "";
      document.getElementById("profile-address").value = profile.address || "";
    }
  
    document.getElementById("userProfileModal").style.display = "flex";
  }
  
  function closeUserProfile() {
    document.getElementById("userProfileModal").style.display = "none";
    document.getElementById("deleteConfirm").style.display = "none";
    document.getElementById("deleteAccountBtn").style.display = "block";
  }
  
  async function handleProfileUpdate(e) {
    e.preventDefault();
    const user = await getCurrentUser();
    if (!user) return;
  
    const username = document.getElementById("profile-username").value.trim();
    const phone = document.getElementById("profile-phone").value.trim();
    const address = document.getElementById("profile-address").value.trim();
  
    const { error } = await window.supabase
      .from("users")
      .update({ username, phone, address })
      .eq("id", user.id);
  
    if (error) {
      showNotification("ไม่สามารถบันทึกข้อมูลได้: " + error.message, "danger");
      return;
    }
    showNotification("บันทึกข้อมูลสำเร็จ", "success");
    updateUIAfterLogin(user);
  }
  
  function showDeleteConfirm() {
    document.getElementById("deleteConfirm").style.display = "block";
    document.getElementById("deleteAccountBtn").style.display = "none";
  }
  
  function cancelDeleteAccount() {
    document.getElementById("deleteConfirm").style.display = "none";
    document.getElementById("deleteAccountBtn").style.display = "block";
  }
  
  async function confirmDeleteAccount() {
    const user = await getCurrentUser();
    if (!user) return;
  
    await window.supabase.from("users").delete().eq("id", user.id);
    await window.supabase.from("wishlist").delete().eq("user_id", user.id);
    await window.supabase.from("cart").delete().eq("user_id", user.id);
  
    const { error } = await window.supabase.auth.admin.deleteUser(user.id);
    if (error) {
      showNotification("ลบบัญชีไม่สำเร็จ: " + error.message, "danger");
      return;
    }
  
    showNotification("ลบบัญชีสำเร็จ กำลังออกจากระบบ...", "success");
    setTimeout(async () => {
      closeUserProfile();
      await window.supabase.auth.signOut();
      location.reload();
    }, 2000);
  }
  
  function showNotification(message, type = "success") {
    const notification = document.getElementById("profileNotification");
    notification.textContent = message;
    notification.className = `alert alert-${type}`;
    notification.style.display = "block";
    setTimeout(() => {
      notification.style.display = "none";
    }, 3000);
  }
  
  window.openUserProfile = openUserProfile;
  window.closeUserProfile = closeUserProfile;
  window.handleProfileUpdate = handleProfileUpdate;
  window.showDeleteConfirm = showDeleteConfirm;
  window.cancelDeleteAccount = cancelDeleteAccount;
  window.confirmDeleteAccount = confirmDeleteAccount;
  window.showNotification = showNotification;
  
  /****************************************************
   * เมื่อโหลดหน้าเว็บ
   ****************************************************/
  window.onload = async function () {
    const user = await getCurrentUser();
    if (user) updateUIAfterLogin(user);
    renderProducts();
    renderAIRecommendations();
    updateCartCount();
  };
  
  window.onclick = function (e) {
    const authModal = document.getElementById("authModal");
    const adminPanel = document.getElementById("adminPanel");
    const productDetailModal = document.getElementById("productDetailModal");
    const checkoutModal = document.getElementById("checkoutModal");
  
    if (e.target === authModal) closeModal();
    if (e.target === adminPanel) closeAdminPanel();
    if (e.target === productDetailModal) closeProductDetail();
    if (e.target === checkoutModal) closeCheckoutModal();
  };
  
  /****************************************************
   * Service Worker Registration
   ****************************************************/
  if ("serviceWorker" in navigator) {
    const swCode = `
      const CACHE_NAME = 'locnet-cache-v1';
      const urlsToCache = [ '/' ];
      self.addEventListener('install', (event) => {
        event.waitUntil(
          caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
        );
      });
      self.addEventListener('fetch', (event) => {
        event.respondWith(
          caches.match(event.request).then((response) => {
            return response || fetch(event.request);
          })
        );
      });
    `;
    const blob = new Blob([swCode], { type: "application/javascript" });
    const swUrl = URL.createObjectURL(blob);
    navigator.serviceWorker
      .register(swUrl)
      .then((registration) => console.log("Service Worker registered with scope:", registration.scope))
      .catch((error) => console.log("Service Worker registration failed:", error));
  }
  
  /****************************************************
   * Blog Read More
   ****************************************************/
  function toggleReadMore(event) {
    event.preventDefault();
    const readMoreLink = event.target;
    const article = readMoreLink.closest(".blog-card");
    const moreContent = article.querySelector(".more-content");
    if (!moreContent) return;
  
    if (moreContent.style.display === "none" || !moreContent.style.display) {
      moreContent.style.display = "block";
      readMoreLink.textContent = "ซ่อน";
    } else {
      moreContent.style.display = "none";
      readMoreLink.textContent = "อ่านต่อ";
    }
  }
  
  /****************************************************
   * Event Listeners
   ****************************************************/
  document.addEventListener("DOMContentLoaded", () => {
    const registerForm = document.getElementById("registerForm");
    if (registerForm) {
      registerForm.addEventListener("submit", handleRegister);
    }
  
    const profileForm = document.getElementById("profileForm");
    if (profileForm) {
      profileForm.addEventListener("submit", handleProfileUpdate);
    }
  
    const closeProfileBtn = document.querySelector(".close-profile");
    if (closeProfileBtn) {
      closeProfileBtn.addEventListener("click", closeUserProfile);
    }
  
    const profileBtn = document.querySelector('[data-action="open-profile"]');
    if (profileBtn) {
      profileBtn.addEventListener("click", openUserProfile);
    }
  
    const btnSync = document.getElementById('btn-sync');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        await syncDataAfterTraining();
        alert('ข้อมูลและโมเดลถูกส่งไปยัง Supabase แล้ว');
      });
    }
  });
